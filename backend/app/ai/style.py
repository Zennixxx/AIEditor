"""Стиль по референсу `/ai/style-from-reference` — docs/BACKEND.md §7.6.

Плотность склеек по секциям берётся из DSP (склейки референса + маркеры его звука), а не из модели;
Gemini (Pro) по видео называет видимые эффекты, замедления и переходы. Стиль сохраняется
как пользовательский в `data/presets.json` (`styles`).
"""

from __future__ import annotations

import bisect
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, get_args

from pydantic import BaseModel, Field

from app.ai.client import LLM, LLMError, TextPart, upload_video
from app.audio.analysis import MusicAnalysisService
from app.effects.registry import Registry
from app.errors import ApiException
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.models.gen import (
    Asset,
    JobRef,
    MarkerKind,
    MusicAnalysis,
    RampPreset,
    SectionLabel,
    StylePreset,
)
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths
from app.storage.presets_repo import PresetsRepo
from app.video.analysis import ClipAnalysisService

log = logging.getLogger(__name__)

PROMPT_VERSION = "style-1"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "style_ref.md").read_text(encoding="utf-8")

HIT_TOLERANCE = 0.08
ON_BASS_SHARE = 0.4
MAX_EVERY = 8
BEAT_SEC_WITHOUT_MUSIC = 0.5
LABELS: tuple[SectionLabel, ...] = get_args(SectionLabel.__value__)


class GStyleEffect(BaseModel):
    effect: str
    section_labels: list[SectionLabel] = Field(default_factory=list)
    kinds: list[MarkerKind] = Field(default_factory=list)
    every: int = 1
    min_strength: float = 0.0
    probability: float = 1.0


class GStyleRamp(BaseModel):
    preset: str
    where: Literal["drop-entry", "section-end", "random"]
    probability: float


class GStyleTransition(BaseModel):
    effect: str
    at: Literal["section-boundary", "downbeat"]
    probability: float


class GeminiStyleResponse(BaseModel):
    name: str = ""
    description: str = ""
    effects: list[GStyleEffect] = Field(default_factory=list)
    global_effects: list[str] = Field(default_factory=list)
    ramps: list[GStyleRamp] = Field(default_factory=list)
    transitions: list[GStyleTransition] = Field(default_factory=list)
    notes: str = ""


@dataclass(slots=True)
class SectionStats:
    label: SectionLabel
    start: float
    end: float
    cuts: int
    on_bass: int
    on_beat: int
    density: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        n = max(1, self.cuts)
        return {
            "section": self.label,
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "cutsPerSec": round(self.cuts / max(self.end - self.start, 1e-6), 2),
            "onBassShare": round(self.on_bass / n, 2),
            "onBeatShare": round(self.on_beat / n, 2),
        }


def _hits(cuts: list[float], times: list[float]) -> list[int]:
    """Индексы `times`, ближайших к склейкам в пределах HIT_TOLERANCE (по одному на склейку)."""
    out: list[int] = []
    for c in cuts:
        i = bisect.bisect_left(times, c)
        near = [j for j in (i - 1, i) if 0 <= j < len(times) and abs(times[j] - c) <= HIT_TOLERANCE]
        if near:
            out.append(min(near, key=lambda j: abs(times[j] - c)))
    return out


def _every(markers: int, cuts: int) -> int:
    return int(min(max(round(markers / max(cuts, 1)), 1), MAX_EVERY))


def section_density(
    start: float, end: float, cuts: list[float], music: MusicAnalysis | None
) -> tuple[dict[str, Any], int, int]:
    inside = [c for c in cuts if start <= c < end]
    if not inside:
        return {"kinds": ["downbeat"], "every": 2, "minStrength": 0}, 0, 0
    if music is None:
        mean_gap = (end - start) / len(inside)
        every = int(min(max(round(mean_gap / BEAT_SEC_WITHOUT_MUSIC), 1), MAX_EVERY))
        return {"kinds": ["beat", "downbeat"], "every": every, "minStrength": 0}, 0, 0
    bass = [b for b in music.bass if start <= b.t < end]
    beats = sorted(t for t in [*music.beats, *music.downbeats] if start <= t < end)
    bass_hits = _hits(inside, [b.t for b in bass])
    beat_hits = _hits(inside, beats)
    if bass and len(bass_hits) >= ON_BASS_SHARE * len(inside):
        strengths = sorted(bass[i].strength for i in bass_hits)
        min_strength = round(max(0.0, strengths[len(strengths) // 10] - 0.05), 2)
        eligible = sum(1 for b in bass if b.strength >= min_strength)
        density = {"kinds": ["bass"], "every": _every(eligible, len(inside)), "minStrength": min_strength}
    else:
        density = {
            "kinds": ["beat", "downbeat"],
            "every": _every(len(set(beats)), len(inside)),
            "minStrength": 0,
        }
    return density, len(bass_hits), len(beat_hits)


def dsp_stats(duration: float, cuts: list[float], music: MusicAnalysis | None) -> list[SectionStats]:
    spans: list[tuple[float, float, SectionLabel]] = (
        [(s.start, s.end, s.label) for s in music.sections] if music and music.sections else []
    )
    if not spans:
        spans = [(0.0, duration, "other")]
    out: list[SectionStats] = []
    for a, b, label in spans:
        density, on_bass, on_beat = section_density(a, b, cuts, music)
        out.append(SectionStats(label, a, b, sum(1 for c in cuts if a <= c < b), on_bass, on_beat, density))
    return out


def cut_density_map(
    stats: list[SectionStats], duration: float, cuts: list[float], music: MusicAnalysis | None
) -> dict[str, Any]:
    overall = section_density(0.0, duration, cuts, music)[0]
    by_label: dict[str, dict[str, Any]] = {}
    for s in sorted(stats, key=lambda s: -s.cuts):
        by_label.setdefault(s.label, s.density)
    return {label: by_label.get(label, overall) for label in LABELS}


def build_style(
    asset: Asset,
    density: dict[str, Any],
    resp: GeminiStyleResponse | None,
    registry: Registry,
    presets: dict[str, RampPreset],
) -> StylePreset:
    def prob(v: float) -> float:
        return round(min(max(v, 0.0), 1.0), 2)

    def usable(effect: str, transition: bool) -> bool:
        d = registry.effects.get(effect)
        return d is not None and (d.category == "transition") == transition

    effects: list[dict[str, Any]] = []
    global_effects: list[dict[str, Any]] = []
    ramps: list[dict[str, Any]] = []
    transitions: list[dict[str, Any]] = []
    if resp is not None:
        for e in resp.effects:
            if not usable(e.effect, False):
                continue
            f: dict[str, Any] = {"kinds": e.kinds or ["bass"], "every": max(1, e.every)}
            if e.min_strength > 0:
                f["minStrength"] = round(min(e.min_strength, 1.0), 2)
            if e.section_labels:
                f["sectionLabels"] = e.section_labels
            effects.append(
                {"effect": e.effect, "params": {}, "filter": f, "probability": prob(e.probability)}
            )
        global_effects = [
            {"effect": g, "params": {}} for g in dict.fromkeys(resp.global_effects) if usable(g, False)
        ]
        ramps = [
            r.model_dump() | {"probability": prob(r.probability)} for r in resp.ramps if r.preset in presets
        ]
        transitions = [
            t.model_dump() | {"probability": prob(t.probability)}
            for t in resp.transitions
            if usable(t.effect, True)
        ]
    name = (resp.name.strip() if resp else "") or f"Стиль: {asset.name}"
    description = (resp.description.strip() if resp else "") or f"Плотность склеек по референсу {asset.name}."
    return StylePreset.model_validate(
        {
            "id": f"ref_{asset.id.removeprefix('ast_')}",
            "name": name,
            "description": description,
            "cutDensity": density,
            "effects": effects,
            "globalEffects": global_effects,
            "ramps": ramps,
            "transitions": transitions,
            "notes": (resp.notes.strip() if resp else "") or None,
        }
    )


def style_prompt(
    stats: list[SectionStats], registry: Registry, presets: dict[str, RampPreset], has_music: bool
) -> str:
    data = {
        "dsp": [s.summary() for s in stats]
        if has_music
        else "у референса нет звука — статистики по музыке нет",
        "effects": [
            {"id": e.id, "hint": e.ai_hint} for e in registry.effects.values() if e.category != "transition"
        ],
        "transitions": [
            {"id": e.id, "hint": e.ai_hint} for e in registry.effects.values() if e.category == "transition"
        ],
        "rampPresets": [{"id": p.id, "description": p.description} for p in presets.values()],
    }
    return "ДАННЫЕ:\n" + json.dumps(data, ensure_ascii=False, separators=(",", ":"))


class StyleRefService:
    def __init__(
        self,
        paths: DataPaths,
        repo: AssetsRepo,
        jobs: JobManager,
        local: ClipAnalysisService,
        music: MusicAnalysisService,
        presets_repo: PresetsRepo,
        registry: Registry,
        ramp_presets: list[RampPreset],
    ) -> None:
        self.paths = paths
        self.repo = repo
        self.jobs = jobs
        self.local = local
        self.music = music
        self.presets_repo = presets_repo
        self.registry = registry
        self.ramp_presets = {p.id: p for p in ramp_presets}

    def start(self, llm: LLM | None, asset: Asset) -> JobRef:
        if asset.kind != "video" or asset.parent is not None:
            raise ApiException(422, "not_video", f"Ассет {asset.id} не видео")
        if asset.derived.proxy is None:
            raise ApiException(409, "asset_not_ready", f"У ассета {asset.id} ещё нет прокси")

        async def run(ctx: JobContext) -> StylePreset:
            return await self._run(ctx, llm, asset.id)

        job = self.jobs.submit(
            "styleRef", run, asset_id=asset.id, resource="light", message="Стиль по референсу"
        )
        return JobRef(job_id=job.id)

    async def _music(self, asset: Asset) -> MusicAnalysis | None:
        if not asset.has_audio:
            return None
        current = self.music.get(asset.id)
        if current is not None:
            return current
        try:
            ref = self.music.start(asset, None)
        except ApiException as exc:
            log.info("Стиль по референсу: анализ звука %s пропущен: %s", asset.id, exc.code)
            return None
        await self.jobs.wait(ref.job_id)
        return self.music.get(asset.id)

    async def _run(self, ctx: JobContext, llm: LLM | None, asset_id: str) -> StylePreset:
        asset = self.repo.get(asset_id)
        if asset is None:
            raise JobFailed("asset_not_found", f"Ассет {asset_id} удалён")
        ctx.progress(0.05, "Склейки референса")
        job_id = self.local.start(asset)
        if job_id is not None:
            await self.jobs.wait(job_id)
        local = self.local.get(asset_id)
        if local is None:
            raise JobFailed("analysis_failed", "Не удалось найти склейки референса")
        cuts = [s.start for s in local.shots[1:]]
        ctx.progress(0.25, "Маркеры звука референса")
        music = await self._music(asset)
        stats = dsp_stats(asset.duration, cuts, music)
        density = cut_density_map(stats, asset.duration, cuts, music)

        resp: GeminiStyleResponse | None = None
        if llm is not None:
            try:
                ctx.progress(0.4, "Загрузка референса в Gemini")
                video = await upload_video(llm, self.paths, asset)
                ctx.progress(0.6, "Gemini смотрит референс")
                resp = await llm.generate(
                    GeminiStyleResponse,
                    [
                        video,
                        TextPart(style_prompt(stats, self.registry, self.ramp_presets, music is not None)),
                    ],
                    system=SYSTEM_PROMPT,
                    tier="pro",
                    prompt_version=PROMPT_VERSION,
                )
            except LLMError as exc:
                raise JobFailed(exc.code, exc.message) from exc
        style = build_style(asset, density, resp, self.registry, self.ramp_presets)
        self.presets_repo.save_style(style)
        log.info("Стиль по референсу %s: %s, %d склеек", asset_id, style.name, len(cuts))
        return style
