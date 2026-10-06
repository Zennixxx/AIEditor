"""Семантика музыки `/ai/analyze-music` — docs/BACKEND.md §7.3.

Gemini только подписывает DSP-секции и может слить или разделить их. Граница принимается, если она
совпадает с границей DSP или даунбитом в пределах SNAP_SEC; энергия секций пересчитывается по
RMS-кривой анализа.
"""

from __future__ import annotations

import json
import logging
from itertools import pairwise
from pathlib import Path

import numpy as np
from pydantic import BaseModel, Field

from app.ai.client import LLM, LLMError, TextPart
from app.audio.analysis import MusicAnalysisService
from app.audio.sections import MIN_SECTION_SEC, span_energy
from app.errors import ApiException
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.models.gen import Asset, JobRef, MusicAnalysis, SectionLabel, SectionSpan
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)

PROMPT_VERSION = "music-1"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "analyze_music.md").read_text(encoding="utf-8")
SNAP_SEC = 0.2


class GSectionLabel(BaseModel):
    start: float
    end: float
    label: SectionLabel
    description: str


class GeminiMusicResponse(BaseModel):
    mood: str = ""
    sections: list[GSectionLabel] = Field(default_factory=list)


def _snap(t: float, candidates: list[float]) -> float | None:
    if not candidates:
        return None
    best = min(candidates, key=lambda c: abs(c - t))
    return best if abs(best - t) <= SNAP_SEC else None


def accepted_edges(analysis: MusicAnalysis, resp: GeminiMusicResponse) -> list[float]:
    dsp = analysis.sections
    start, end = dsp[0].start, dsp[-1].end
    dsp_inner = [s.start for s in dsp[1:]]
    edges = [start]
    for s in sorted(resp.sections, key=lambda s: s.start)[1:]:
        t = _snap(s.start, dsp_inner)
        if t is None:
            t = _snap(s.start, analysis.downbeats)
        if t is None or t - edges[-1] < MIN_SECTION_SEC or end - t < MIN_SECTION_SEC:
            continue
        edges.append(t)
    edges.append(end)
    return edges


def enrich_sections(analysis: MusicAnalysis, resp: GeminiMusicResponse) -> list[SectionSpan]:
    if not analysis.sections or not resp.sections:
        return analysis.sections
    energy = np.asarray(analysis.energy.values, dtype=np.float64)
    out: list[SectionSpan] = []
    for a, b in pairwise(accepted_edges(analysis, resp)):
        best = max(resp.sections, key=lambda s: min(b, s.end) - max(a, s.start))
        overlap = min(b, best.end) - max(a, best.start)
        dsp = max(analysis.sections, key=lambda s: min(b, s.end) - max(a, s.start))
        e = span_energy(energy, analysis.energy.interval, a, b) if energy.size else dsp.energy
        out.append(
            SectionSpan(
                start=round(a, 4),
                end=round(b, 4),
                label=best.label if overlap > 0 else dsp.label,
                energy=round(e, 3),
                description=best.description.strip() or None if overlap > 0 else None,
            )
        )
    return out


def music_prompt(analysis: MusicAnalysis) -> str:
    sections = [
        {"start": round(s.start, 2), "end": round(s.end, 2), "dspLabel": s.label, "energy": s.energy}
        for s in analysis.sections
    ]
    return (
        f"BPM: {analysis.bpm:.1f}\n"
        f"DSP-СЕКЦИИ: {json.dumps(sections, ensure_ascii=False)}\n"
        f"ДАУНБИТЫ: {json.dumps([round(t, 2) for t in analysis.downbeats])}\n"
        "Подпиши секции трека."
    )


class MusicAIService:
    def __init__(self, paths: DataPaths, jobs: JobManager, analysis: MusicAnalysisService) -> None:
        self.paths = paths
        self.jobs = jobs
        self.analysis = analysis
        self._inflight: dict[str, str] = {}

    def _audio(self, asset_id: str) -> Path:
        return self.paths.asset_dir(asset_id) / "audio.m4a"

    def start(self, llm: LLM, asset: Asset) -> JobRef:
        if asset.kind == "image" or (asset.kind == "video" and not asset.has_audio):
            raise ApiException(422, "no_audio", f"В ассете {asset.id} нет звука для анализа")
        if not self._audio(asset.id).is_file():
            raise ApiException(409, "asset_not_ready", f"У ассета {asset.id} ещё нет audio.m4a")
        running = self._inflight.get(asset.id)
        if running is not None and (job := self.jobs.get(running)) and job.status in ("queued", "running"):
            return JobRef(job_id=running)
        deps = [] if self.analysis.get(asset.id) is not None else [self.analysis.start(asset, None).job_id]

        async def run(ctx: JobContext) -> MusicAnalysis:
            return await self._run(ctx, llm, asset.id)

        job = self.jobs.submit(
            "aiMusic",
            run,
            asset_id=asset.id,
            resource="gemini",
            message="ИИ-разметка секций",
            depends_on=deps,
        )
        self._inflight[asset.id] = job.id
        return JobRef(job_id=job.id)

    async def _run(self, ctx: JobContext, llm: LLM, asset_id: str) -> MusicAnalysis:
        analysis = self.analysis.get(asset_id)
        if analysis is None:
            raise JobFailed("analysis_not_found", f"Анализ музыки для {asset_id} не выполнен")
        if not analysis.sections:
            return analysis
        try:
            ctx.progress(0.1, "Загрузка аудио в Gemini")
            audio = await llm.upload(self._audio(asset_id), "audio/mp4")
            ctx.progress(0.4, "Gemini слушает трек")
            resp = await llm.generate(
                GeminiMusicResponse,
                [audio, TextPart(music_prompt(analysis))],
                system=SYSTEM_PROMPT,
                tier="fast",
                prompt_version=PROMPT_VERSION,
            )
        except LLMError as exc:
            raise JobFailed(exc.code, exc.message) from exc
        enriched = analysis.model_copy(update={"sections": enrich_sections(analysis, resp)})
        self.analysis.replace(enriched)
        log.info("ИИ-секции %s: %d → %d", asset_id, len(analysis.sections), len(enriched.sections))
        return enriched
