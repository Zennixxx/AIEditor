"""ИИ-анализ клипа `/ai/analyze-clip` — docs/BACKEND.md §7.2.

Gemini получает прокси и локальные склейки, возвращает моменты и крупность планов. Таймкоды моментов
обрезаются по длительности и уточняются по кривой движения; результат дополняет локальный
`analysis/clip.json` (движение и склейки остаются локальными).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from pydantic import BaseModel, Field

from app.ai.client import LLM, LLMError, TextPart, upload_video
from app.errors import ApiException
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.models.gen import Asset, ClipAnalysis, Curve, JobRef, Moment, Shot, ShotType
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths
from app.video.analysis import ClipAnalysisService

log = logging.getLogger(__name__)

PROMPT_VERSION = "clip-1"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "analyze_clip.md").read_text(encoding="utf-8")

REFINE_WINDOW = 0.5
MIN_MOMENT_SEC = 0.2
MAX_MOMENTS = 20
MAX_TAGS = 5


class GMoment(BaseModel):
    start: float
    end: float
    score: float
    tags: list[str]
    description: str


class GShotType(BaseModel):
    start: float
    end: float
    type: ShotType


class GeminiClipResponse(BaseModel):
    summary: str
    moments: list[GMoment] = Field(default_factory=list)
    shot_types: list[GShotType] = Field(default_factory=list)


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(max(v, lo), hi)


def _shot_bounds(shots: list[Shot], t: float, duration: float) -> tuple[float, float]:
    for s in shots:
        if s.start <= t < s.end:
            return s.start, s.end
    return 0.0, duration


def refine_bounds(
    start: float, end: float, motion: Curve, shots: list[Shot], duration: float
) -> tuple[float, float]:
    """Расширить момент до локального минимума движения в пределах ±REFINE_WINDOW, не выходя из плана."""
    values, step = motion.values, motion.interval
    if not values or step <= 0:
        return start, end
    lo, _ = _shot_bounds(shots, start, duration)
    _, hi = _shot_bounds(shots, max(start, end - 1e-6), duration)

    first = max(0, int(-(-max(lo, start - REFINE_WINDOW) // step)))
    last = min(len(values) - 1, int(start // step))
    if first <= last:
        best = min(range(last, first - 1, -1), key=lambda i: values[i])
        if values[best] < values[last]:
            start = best * step

    first = max(0, int(-(-end // step)))
    last = min(len(values) - 1, int(min(hi, end + REFINE_WINDOW) // step))
    if first <= last:
        best = min(range(first, last + 1), key=lambda i: values[i])
        if values[best] < values[first]:
            end = best * step
    return round(_clamp(start, 0.0, duration), 3), round(_clamp(end, 0.0, duration), 3)


def _tags(raw: list[str]) -> list[str]:
    out: list[str] = []
    for t in raw:
        tag = t.strip().lower()
        if tag and tag not in out:
            out.append(tag)
    return out[:MAX_TAGS]


def merge_analysis(
    local: ClipAnalysis, resp: GeminiClipResponse, duration: float, model: str
) -> ClipAnalysis:
    moments: list[Moment] = []
    for m in resp.moments:
        start, end = _clamp(m.start, 0.0, duration), _clamp(m.end, 0.0, duration)
        if end - start < MIN_MOMENT_SEC:
            continue
        start, end = refine_bounds(start, end, local.motion, local.shots, duration)
        moments.append(
            Moment(
                start=start,
                end=end,
                score=round(_clamp(m.score, 0.0, 1.0), 3),
                tags=_tags(m.tags),
                description=m.description.strip(),
            )
        )
    moments.sort(key=lambda m: -m.score)
    moments = sorted(moments[:MAX_MOMENTS], key=lambda m: m.start)

    shots: list[Shot] = []
    for s in local.shots:
        overlaps: dict[ShotType, float] = {}
        for t in resp.shot_types:
            overlaps[t.type] = overlaps.get(t.type, 0.0) + max(0.0, min(s.end, t.end) - max(s.start, t.start))
        kind, overlap = max(overlaps.items(), key=lambda kv: kv[1], default=("other", 0.0))
        shots.append(Shot(start=s.start, end=s.end, type=kind if overlap > 0 else "other"))

    return ClipAnalysis(
        asset_id=local.asset_id,
        model=model,
        summary=resp.summary.strip(),
        moments=moments,
        shots=shots,
        motion=local.motion,
    )


def _empty_local(asset: Asset) -> ClipAnalysis:
    return ClipAnalysis(
        asset_id=asset.id,
        model="",
        summary="",
        moments=[],
        shots=[Shot(start=0.0, end=asset.duration, type="other")],
        motion=Curve(interval=0.1, values=[]),
    )


def clip_prompt(asset: Asset, local: ClipAnalysis) -> str:
    shots = [[round(s.start, 2), round(s.end, 2)] for s in local.shots]
    return (
        f"ДЛИТЕЛЬНОСТЬ: {asset.duration:.2f} с\n"
        f"ПЛАНЫ [start, end]: {json.dumps(shots)}\n"
        "Найди моменты для эдита и определи крупность каждого плана."
    )


class ClipAIService:
    def __init__(
        self, paths: DataPaths, repo: AssetsRepo, jobs: JobManager, local: ClipAnalysisService
    ) -> None:
        self.paths = paths
        self.repo = repo
        self.jobs = jobs
        self.local = local
        self._inflight: dict[str, str] = {}

    def start(self, llm: LLM, asset: Asset, force: bool) -> JobRef:
        if asset.kind != "video" or asset.parent is not None:
            raise ApiException(422, "not_video", f"Ассет {asset.id} не видео")
        if asset.derived.proxy is None:
            raise ApiException(409, "asset_not_ready", f"У ассета {asset.id} ещё нет прокси")
        running = self._inflight.get(asset.id)
        if running is not None and (job := self.jobs.get(running)) and job.status in ("queued", "running"):
            return JobRef(job_id=running)
        local_job = self.local.start(asset)

        async def run(ctx: JobContext) -> ClipAnalysis:
            return await self._run(ctx, llm, asset.id, force)

        job = self.jobs.submit(
            "clipAnalysis",
            run,
            asset_id=asset.id,
            resource="gemini",
            message="ИИ-анализ клипа",
            depends_on=[local_job] if local_job else [],
        )
        self._inflight[asset.id] = job.id
        return JobRef(job_id=job.id)

    async def _run(self, ctx: JobContext, llm: LLM, asset_id: str, force: bool) -> ClipAnalysis:
        asset = self.repo.get(asset_id)
        if asset is None:
            raise JobFailed("asset_not_found", f"Ассет {asset_id} удалён")
        existing = self.local.get(asset_id)
        if existing is not None and existing.model and not force:
            ctx.progress(1.0, "Из кэша")
            return existing
        local = existing or _empty_local(asset)
        try:
            ctx.progress(0.1, "Загрузка видео в Gemini")
            video = await upload_video(llm, self.paths, asset)
            ctx.progress(0.4, "Gemini смотрит клип")
            resp = await llm.generate(
                GeminiClipResponse,
                [video, TextPart(clip_prompt(asset, local))],
                system=SYSTEM_PROMPT,
                tier="pro",
                prompt_version=PROMPT_VERSION,
            )
        except LLMError as exc:
            raise JobFailed(exc.code, exc.message) from exc
        analysis = merge_analysis(local, resp, asset.duration, llm.model_name("pro"))
        self.local.write(analysis)
        log.info("ИИ-анализ %s: %d моментов", asset_id, len(analysis.moments))
        return analysis
