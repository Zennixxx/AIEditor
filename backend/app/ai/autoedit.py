"""Автоэдит `/ai/auto-edit` — docs/BACKEND.md §7.5, DECISIONS #6.

Каркас детерминированный: слоты между маркерами по плотности стиля, кандидаты — моменты анализа
клипов (без Gemini — окна с высокой энергией движения). Gemini (Pro) только назначает моменты
слотам, предлагает ramp и эффекты; без ключа работает жадное назначение. Ops проходят сухой прогон.
"""

from __future__ import annotations

import json
import logging
import random
from collections import Counter
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.ai.client import LLM, LLMError, TextPart
from app.ai.clip import ClipAIService
from app.ai.timeline import (
    EPS,
    OpsError,
    TimelineMarker,
    dedupe_close,
    filter_markers,
    find_clip,
    timeline_sections,
)
from app.ai.validate_ops import DryRun
from app.effects.registry import Registry
from app.errors import ApiException
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.models.gen import (
    Asset,
    AutoEditRequest,
    ClipAnalysis,
    CutDensity,
    JobRef,
    MarkerFilter,
    MarkerKind,
    Project,
    RampPreset,
    SectionLabel,
    StylePreset,
    StylesFile,
    TimeRange,
)
from app.models.ops import StrictEditOp, dump_op, parse_op
from app.storage.assets_repo import AssetsRepo
from app.storage.atomic import read_json
from app.timeremap import integral, keys_from_json
from app.video.analysis import ClipAnalysisService

log = logging.getLogger(__name__)

PROMPT_VERSION = "autoedit-1"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "auto_edit.md").read_text(encoding="utf-8")

SEED = 1
MIN_RAMP_SEC = 0.6
WINDOW_SEC = 2.0
WINDOW_STEP = 1.0
MIN_WINDOW_SEC = 0.5
WINDOWS_PER_ASSET = 12
MAX_PROMPT_MOMENTS = 80
REUSE_PENALTY = 0.35
NEIGHBOR_PENALTY = 1.0
SHORT_PENALTY = 0.25
MIN_FALLBACK_SECTION = 2.0
FALLBACK_KINDS: list[MarkerKind] = ["downbeat", "beat", "bass"]
VIDEO_TRACK = "tmp_autoedit"
TRANSITION_TRACK = "tmp_autoedit_transitions"


@dataclass(slots=True)
class Slot:
    id: str
    start: float
    end: float
    label: SectionLabel
    energy: float
    strength: float
    kind: MarkerKind

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(slots=True)
class Candidate:
    id: str
    asset: Asset
    start: float
    end: float
    score: float
    tags: list[str] = field(default_factory=list)
    description: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start


class GAssignment(BaseModel):
    slot_id: str
    moment_id: str
    reason: str = ""


class GEffectSuggestion(BaseModel):
    effect: str
    section_labels: list[SectionLabel] = Field(default_factory=list)
    kinds: list[MarkerKind] = Field(default_factory=list)
    every: int = 1
    min_strength: float = 0.0


class GRamp(BaseModel):
    slot_id: str
    preset: str


class GeminiAutoEditResponse(BaseModel):
    assignments: list[GAssignment] = Field(default_factory=list)
    effect_suggestions: list[GEffectSuggestion] = Field(default_factory=list)
    ramps: list[GRamp] = Field(default_factory=list)


@dataclass(slots=True)
class Plan:
    assignment: dict[str, Candidate]
    ramps: dict[str, RampPreset]
    suggestions: list[GEffectSuggestion]
    ai: bool


def load_styles(shared_dir: Path) -> dict[str, StylePreset]:
    try:
        return {s.id: s for s in StylesFile.model_validate(read_json(shared_dir / "styles.json")).styles}
    except (FileNotFoundError, ValueError) as exc:
        log.error("Стили не загружены: %s", exc)
        return {}


def _density(style: StylePreset, label: SectionLabel) -> CutDensity:
    return getattr(style.cut_density, "break_" if label == "break" else label)


# ---------- шаг 1: слоты ----------


def build_slots(p: Project, music_id: str, span: tuple[float, float], style: StylePreset) -> list[Slot]:
    frame = 1 / p.fps
    lo, hi = span
    sections = [s for s in timeline_sections(p) if s.clip_id == music_id] or [
        s for s in timeline_sections(p) if s.clip_id is None
    ]
    spans: list[tuple[float, float, SectionLabel, float]] = [
        (max(s.start, lo), min(s.end, hi), s.label, s.energy) for s in sections if s.end > lo and s.start < hi
    ]
    if not spans:
        spans = [(lo, hi, "other", 0.5)]

    cuts: dict[float, TimelineMarker | None] = {lo: None, hi: None}
    for a, b, label, _ in spans:
        d = _density(style, label)
        inside: list[TimelineMarker] = []
        for kinds, min_strength in ((d.kinds, d.min_strength), (FALLBACK_KINDS, 0.0)):
            f = MarkerFilter(
                music_clip_id=music_id,
                kinds=kinds,
                min_strength=min_strength,
                every=d.every,
                offset=None,
                section_labels=None,
                range=TimeRange(start=a, end=b),
            )
            inside = [tm for tm in filter_markers(p, f) if a - EPS <= tm.t < b - EPS]
            if b - a < MIN_FALLBACK_SECTION or any(tm.t > a + frame for tm in inside):
                break
        for tm in inside:
            if lo + frame <= tm.t <= hi - frame:
                cuts.setdefault(tm.t, tm)
    points = sorted(cuts)
    kept = [points[0]]
    for t in points[1:-1]:
        if t - kept[-1] >= 2 * frame - EPS and hi - t >= 2 * frame - EPS:
            kept.append(t)
    kept.append(hi)

    def section_at(t: float) -> tuple[SectionLabel, float]:
        for a, b, label, energy in spans:
            if a - EPS <= t < b - EPS:
                return label, energy
        return spans[-1][2], spans[-1][3]

    slots: list[Slot] = []
    for i, (a, b) in enumerate(pairwise(kept)):
        label, energy = section_at(a)
        tm = cuts.get(a)
        slots.append(
            Slot(
                id=f"s{i + 1}",
                start=a,
                end=b,
                label=label,
                energy=energy,
                strength=tm.marker.strength if tm else 1.0,
                kind=tm.marker.kind if tm else "downbeat",
            )
        )
    return slots


# ---------- шаг 2: кандидаты ----------


def motion_windows(asset: Asset, analysis: ClipAnalysis | None) -> list[tuple[float, float, float]]:
    """Окна с наибольшей энергией движения: (start, end, score), не пересекаются, внутри планов."""
    dur = asset.duration
    shots = [(s.start, s.end) for s in analysis.shots] if analysis and analysis.shots else [(0.0, dur)]
    values = analysis.motion.values if analysis else []
    step = analysis.motion.interval if analysis else 0.1

    def score(a: float, b: float) -> float:
        part = values[int(a / step) : max(int(a / step) + 1, int(b / step))] if values else []
        return round(sum(part) / len(part), 3) if part else 0.5

    windows: list[tuple[float, float, float]] = []
    for a, b in shots:
        b = min(b, dur)
        if b - a < MIN_WINDOW_SEC:
            continue
        if b - a <= WINDOW_SEC:
            windows.append((a, b, score(a, b)))
            continue
        t = a
        while t + WINDOW_SEC <= b + EPS:
            windows.append((t, t + WINDOW_SEC, score(t, t + WINDOW_SEC)))
            t += WINDOW_STEP
    chosen: list[tuple[float, float, float]] = []
    for w in sorted(windows, key=lambda w: (-w[2], w[0])):
        if all(w[1] <= c[0] + EPS or w[0] >= c[1] - EPS for c in chosen):
            chosen.append(w)
        if len(chosen) >= WINDOWS_PER_ASSET:
            break
    return sorted(chosen) or [(0.0, dur, 0.5)]


def build_candidates(assets: list[Asset], analyses: dict[str, ClipAnalysis | None]) -> list[Candidate]:
    out: list[Candidate] = []

    def add(asset: Asset, a: float, b: float, score: float, tags: list[str], desc: str) -> None:
        out.append(Candidate(f"m{len(out) + 1}", asset, a, b, score, tags, desc))

    for asset in assets:
        analysis = analyses.get(asset.id)
        if asset.kind == "image":
            add(asset, 0.0, 0.0, 0.5, ["image"], asset.name)
        elif analysis and analysis.moments:
            for m in analysis.moments:
                add(asset, m.start, m.end, m.score, list(m.tags), m.description)
        else:
            for a, b, s in motion_windows(asset, analysis):
                add(asset, a, b, s, ["motion"], f"{asset.name} {a:.1f}–{b:.1f} с")
    return out


# ---------- шаг 3: назначение ----------


def assign_greedy(
    slots: list[Slot], cands: list[Candidate], fixed: dict[str, Candidate] | None = None
) -> dict[str, Candidate]:
    result = dict(fixed or {})
    uses = Counter(c.id for c in result.values())
    index = {s.id: i for i, s in enumerate(slots)}
    order = sorted(slots, key=lambda s: (-(s.energy * (0.5 + 0.5 * s.strength)), s.start))
    for s in order:
        if s.id in result:
            continue
        i = index[s.id]
        neighbors = {
            result[slots[j].id].id for j in (i - 1, i + 1) if 0 <= j < len(slots) and slots[j].id in result
        }

        def value(c: Candidate, s: Slot = s, neighbors: set[str] = neighbors) -> float:
            v = c.score - REUSE_PENALTY * uses[c.id]
            if c.id in neighbors and len(cands) > 1:
                v -= NEIGHBOR_PENALTY
            if c.asset.kind != "image" and c.duration < s.duration * 0.5:
                v -= SHORT_PENALTY
            return v

        best = max(cands, key=value)
        result[s.id] = best
        uses[best.id] += 1
    return result


def style_ramps(
    slots: list[Slot], style: StylePreset, presets: dict[str, RampPreset], rng: random.Random
) -> dict[str, RampPreset]:
    out: dict[str, RampPreset] = {}
    for rule in style.ramps:
        preset = presets.get(rule.preset)
        if preset is None:
            continue
        if rule.where == "drop-entry":
            targets = [
                s
                for i, s in enumerate(slots)
                if i + 1 < len(slots) and slots[i + 1].label == "drop" and s.label != "drop"
            ]
        elif rule.where == "section-end":
            targets = [s for i, s in enumerate(slots) if i + 1 < len(slots) and slots[i + 1].label != s.label]
        else:
            targets = list(slots)
        for s in targets:
            if s.id not in out and s.duration >= MIN_RAMP_SEC and rng.random() < rule.probability:
                out[s.id] = preset
    return out


def slots_prompt(
    slots: list[Slot],
    cands: list[Candidate],
    style: StylePreset,
    presets: list[RampPreset],
    registry: Registry,
) -> str:
    moments = sorted(cands, key=lambda c: -c.score)[:MAX_PROMPT_MOMENTS]
    data = {
        "slots": [
            {
                "id": s.id,
                "duration": round(s.duration, 2),
                "section": s.label,
                "energy": s.energy,
                "strength": round(s.strength, 2),
            }
            for s in slots
        ],
        "moments": [
            {
                "id": c.id,
                "duration": round(c.duration, 2) if c.asset.kind != "image" else None,
                "score": c.score,
                "tags": c.tags,
                "description": c.description,
            }
            for c in moments
        ],
        "style": {
            "name": style.name,
            "description": style.description,
            "effects": sorted({e.effect for e in style.effects}),
        },
        "rampPresets": [{"id": p.id, "description": p.description} for p in presets],
        "effects": [
            {"id": e.id, "hint": e.ai_hint} for e in registry.effects.values() if e.category != "transition"
        ],
    }
    return "ДАННЫЕ:\n" + json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def plan_from_gemini(
    resp: GeminiAutoEditResponse,
    slots: list[Slot],
    cands: list[Candidate],
    presets: dict[str, RampPreset],
    registry: Registry,
) -> tuple[Plan, list[str]]:
    slot_ids = {s.id: s for s in slots}
    by_id = {c.id: c for c in cands}
    fixed: dict[str, Candidate] = {}
    bad = 0
    for a in resp.assignments:
        if a.slot_id in slot_ids and a.moment_id in by_id and a.slot_id not in fixed:
            fixed[a.slot_id] = by_id[a.moment_id]
        else:
            bad += 1
    warnings: list[str] = []
    missing = len(slots) - len(fixed)
    if missing:
        warnings.append(f"Gemini не назначил {missing} слотов — заполнены автоматически")
    if bad:
        warnings.append(f"Отброшено {bad} назначений Gemini с неизвестными слотами или моментами")
    ramps = {
        r.slot_id: presets[r.preset]
        for r in resp.ramps
        if r.slot_id in slot_ids and r.preset in presets and slot_ids[r.slot_id].duration >= MIN_RAMP_SEC
    }
    suggestions = [
        s
        for s in resp.effect_suggestions
        if s.effect in registry.effects and registry.effects[s.effect].category != "transition"
    ]
    return Plan(assign_greedy(slots, cands, fixed), ramps, suggestions, True), warnings


# ---------- шаг 4: сборка ops ----------


def _r(x: float) -> float:
    return round(x, 6)


def clip_for_slot(s: Slot, c: Candidate, ramp: RampPreset | None) -> dict[str, Any]:
    d = s.duration
    asset = c.asset
    clip: dict[str, Any] = {
        "type": "clip",
        "assetId": asset.id,
        "start": s.start,
        "duration": d,
        "reverse": False,
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "anchorX": 0, "anchorY": 0},
        "opacity": 1,
        "blendMode": "normal",
        "effects": [],
        "markers": [],
    }
    if asset.has_audio:
        clip["volume"] = 0
    if asset.kind == "image":
        return {**clip, "sourceIn": 0, "sourceOut": d, "speed": 1}
    remap = ramp.time_remap.model_dump(mode="json", by_alias=True, exclude_none=True) if ramp else None
    avg = integral(keys_from_json(remap["keyframes"]), 1.0) if remap else 1.0
    need = d * avg
    if need >= asset.duration:
        a, b = 0.0, asset.duration
    else:
        center = (c.start + c.end) / 2
        a = min(max(center - need / 2, 0.0), asset.duration - need)
        b = a + need
    clip.update(sourceIn=a, sourceOut=b, speed=1 if remap or need < asset.duration else (b - a) / d)
    if remap:
        clip["timeRemap"] = remap
    return clip


def _strength_param(
    registry: Registry, effect: str, intensity: float, params: dict[str, Any]
) -> dict[str, Any]:
    definition = registry.effects[effect]
    defs = {p.key: p for p in definition.params}
    out = {k: v for k, v in params.items() if not registry.param_errors(effect, {k: v}, "")}
    p = defs.get("strength")
    if p is not None:
        base = float(out.get("strength", p.default))
        lo, hi = p.min if p.min is not None else 0.0, p.max if p.max is not None else 2.0
        out["strength"] = round(min(max(base * (0.5 + intensity), lo), hi), 2)
    return out


def effect_ops(
    p: Project,
    music_id: str,
    span: tuple[float, float],
    style: StylePreset,
    suggestions: list[GEffectSuggestion],
    registry: Registry,
    intensity: float,
    rng: random.Random,
) -> tuple[list[dict[str, Any]], list[str]]:
    if intensity <= 0:
        return [], []
    rules: list[tuple[str, dict[str, Any], MarkerFilter, float]] = [
        (r.effect, dict(r.params), r.filter, r.probability) for r in style.effects
    ]
    have = {r[0] for r in rules}
    for sg in suggestions:
        if sg.effect in have:
            continue
        have.add(sg.effect)
        f = MarkerFilter(
            music_clip_id=None,
            offset=None,
            kinds=sg.kinds or None,
            min_strength=min(max(sg.min_strength, 0.0), 1.0) or None,
            every=max(1, sg.every),
            section_labels=sg.section_labels or None,
        )
        rules.append((sg.effect, {}, f, 1.0))

    ops: list[dict[str, Any]] = []
    used: list[str] = []
    for effect, params, base, probability in rules:
        if effect not in registry.effects or rng.random() >= probability:
            continue
        lo, hi = span
        if base.range is not None:
            lo, hi = max(lo, base.range.start), min(hi, base.range.end)
        if hi <= lo:
            continue
        every = base.every or 1
        f = base.model_copy(
            update={
                "music_clip_id": music_id,
                "range": TimeRange(start=lo, end=hi),
                "every": every * 2 if intensity < 0.34 else every,
            }
        )
        try:
            if not dedupe_close(filter_markers(p, f), p.fps):
                continue
        except OpsError:
            continue
        ops.append(
            {
                "op": "applyEffectToMarkers",
                "effect": effect,
                "params": _strength_param(registry, effect, intensity, params),
                "scaleByStrength": True,
                "filter": f.model_dump(mode="json", by_alias=True, exclude_none=True),
                "target": "newFxTrack",
            }
        )
        used.append(effect)
    return ops, used


def transition_ops(
    slots: list[Slot], style: StylePreset, registry: Registry, intensity: float, rng: random.Random
) -> list[dict[str, Any]]:
    if intensity <= 0 or not style.transitions:
        return []
    items: list[dict[str, Any]] = []
    last_end = -1.0
    for prev, nxt in pairwise(slots):
        t = nxt.start
        boundary = prev.label != nxt.label
        for rule in style.transitions:
            if rule.effect not in registry.effects:
                continue
            if rule.at == "section-boundary" and not boundary:
                continue
            if rule.at == "downbeat" and nxt.kind != "downbeat":
                continue
            chance = rule.probability if rule.at == "section-boundary" else rule.probability * intensity
            if rng.random() >= chance:
                continue
            definition = registry.effects[rule.effect]
            d = min(definition.default_duration, prev.duration, nxt.duration)
            start = t - d / 2
            if start < last_end - EPS:
                break
            items.append(
                {
                    "op": "addEffect",
                    "target": {"trackId": TRANSITION_TRACK},
                    "effect": {
                        "effect": rule.effect,
                        "start": _r(start),
                        "duration": _r(d),
                        "params": {},
                        "envelope": definition.default_envelope.model_dump(mode="json"),
                        "enabled": True,
                    },
                }
            )
            last_end = start + d
            break
    if not items:
        return []
    track = {
        "op": "addTrack",
        "track": {
            "id": TRANSITION_TRACK,
            "kind": "fx",
            "name": "Переходы",
            "muted": False,
            "locked": False,
            "hidden": False,
        },
    }
    return [track, *items]


def global_ops(
    span: tuple[float, float], style: StylePreset, registry: Registry, intensity: float
) -> list[dict[str, Any]]:
    if intensity <= 0:
        return []
    lo, hi = span
    ops: list[dict[str, Any]] = []
    for i, g in enumerate(style.global_effects or []):
        definition = registry.effects.get(g.effect)
        if definition is None:
            continue
        track_id = f"tmp_autoedit_global{i + 1}"
        ops.append(
            {
                "op": "addTrack",
                "track": {
                    "id": track_id,
                    "kind": "fx",
                    "name": f"FX: {definition.name}",
                    "muted": False,
                    "locked": False,
                    "hidden": False,
                },
            }
        )
        ops.append(
            {
                "op": "addEffect",
                "target": {"trackId": track_id},
                "effect": {
                    "effect": g.effect,
                    "start": lo,
                    "duration": hi - lo,
                    "params": {
                        k: v for k, v in g.params.items() if not registry.param_errors(g.effect, {k: v}, "")
                    },
                    "envelope": {"attack": 0, "hold": hi - lo, "decay": 0, "curve": "linear"},
                    "enabled": True,
                },
            }
        )
    return ops


# ---------- шаг 5: проверка ----------


def validate(
    p: Project, raw_ops: list[dict[str, Any]], registry: Registry, resolve: Any
) -> tuple[list[StrictEditOp], list[str]]:
    dry = DryRun(p.model_copy(deep=True), registry, resolve)
    ops: list[StrictEditOp] = []
    warnings: list[str] = []
    for raw in raw_ops:
        saved = (dry.project.model_copy(deep=True), set(dry.ids), dict(dry.id_map))
        try:
            op = parse_op(raw)
            dry.apply(op)
        except OpsError as exc:
            dry.project, dry.ids, dry.id_map = saved
            warnings.append(f"Пропущено: {raw['op']} [{exc.code}]: {exc.message}")
            continue
        ops.append(op)
    violations = dry.finalize()
    if violations:
        raise JobFailed("autoedit_invalid", "Автоэдит нарушает инварианты: " + "; ".join(violations[:5]))
    return ops, warnings


def explain(slots: list[Slot], ramps: int, effects: list[str], transitions: int, ai: bool) -> str:
    labels: list[str] = []
    for s in slots:
        if not labels or labels[-1] != s.label:
            labels.append(s.label)
    parts = [f"{len(slots)} клипов по маркерам ({' → '.join(labels)})"]
    if effects:
        parts.append("эффекты: " + ", ".join(effects))
    if ramps:
        parts.append(f"speed ramp на {ramps} клипах")
    if transitions:
        parts.append(f"переходов: {transitions}")
    text = "Автоэдит: " + "; ".join(parts) + "."
    return text if ai else text + " Моменты подобраны без Gemini — по энергии движения."


# ---------- сервис ----------


@dataclass(slots=True)
class EditInput:
    req: AutoEditRequest
    style: StylePreset
    span: tuple[float, float]
    assets: list[Asset]


class AutoEditService:
    def __init__(
        self,
        registry: Registry,
        styles: dict[str, StylePreset],
        ramp_presets: list[RampPreset],
        repo: AssetsRepo,
        jobs: JobManager,
        local: ClipAnalysisService,
        clip_ai: ClipAIService,
    ) -> None:
        self.registry = registry
        self.styles = styles
        self.presets = {p.id: p for p in ramp_presets}
        self.repo = repo
        self.jobs = jobs
        self.local = local
        self.clip_ai = clip_ai

    def _asset(self, p: Project, asset_id: str) -> Asset | None:
        return self.repo.get(asset_id) or next((a for a in p.assets if a.id == asset_id), None)

    def check(self, req: AutoEditRequest) -> EditInput:
        p = req.project
        ref = find_clip(p, req.music_clip_id)
        if ref is None:
            raise ApiException(422, "clip_not_found", f"Музыкальный клип {req.music_clip_id} не найден")
        music = ref[1]
        if not music.markers:
            raise ApiException(422, "no_markers", "У музыкального клипа нет маркеров — сначала анализ музыки")
        if req.style == "custom":
            if req.custom_style is None:
                raise ApiException(422, "unknown_style", "style=custom требует customStyle")
            style = req.custom_style
        else:
            found = self.styles.get(req.style)
            if found is None:
                raise ApiException(422, "unknown_style", f"Стиль {req.style!r} не найден")
            style = found
        lo, hi = music.start, music.start + music.duration
        if req.range is not None:
            lo, hi = max(lo, req.range.start), min(hi, req.range.end)
        if hi - lo < 2 / p.fps:
            raise ApiException(422, "bad_range", "Диапазон эдита пуст или вне музыкального клипа")
        assets: list[Asset] = []
        for asset_id in dict.fromkeys(req.asset_ids):
            asset = self._asset(p, asset_id)
            if asset is None:
                raise ApiException(404, "asset_not_found", f"Ассет {asset_id} не найден")
            if asset.kind == "audio" or asset.parent is not None:
                raise ApiException(422, "not_video", f"Ассет {asset_id} не видео и не изображение")
            assets.append(asset)
        return EditInput(req, style, (lo, hi), assets)

    def start(self, llm: LLM | None, req: AutoEditRequest) -> JobRef:
        inp = self.check(req)

        async def run(ctx: JobContext) -> dict[str, Any]:
            return await self.run(ctx, llm, inp)

        job = self.jobs.submit("autoEdit", run, resource="light", message="Автоэдит")
        return JobRef(job_id=job.id)

    async def _analyses(
        self, ctx: JobContext, llm: LLM | None, assets: list[Asset]
    ) -> dict[str, ClipAnalysis | None]:
        out: dict[str, ClipAnalysis | None] = {}
        videos = [a for a in assets if a.kind == "video"]
        for i, asset in enumerate(videos):
            ctx.progress(0.05 + 0.6 * i / max(1, len(videos)), f"Анализ клипа {asset.name}")
            current = self.local.get(asset.id)
            job_id: str | None = None
            if llm is not None and (current is None or not current.model) and asset.derived.proxy:
                try:
                    job_id = self.clip_ai.start(llm, asset, False).job_id
                except ApiException as exc:
                    log.info("Автоэдит: ИИ-анализ %s пропущен: %s", asset.id, exc.code)
            if job_id is None and current is None:
                job_id = self.local.start(asset)
            if job_id is not None:
                await self.jobs.wait(job_id)
            out[asset.id] = self.local.get(asset.id)
        return out

    async def run(self, ctx: JobContext, llm: LLM | None, inp: EditInput) -> dict[str, Any]:
        req, style, span = inp.req, inp.style, inp.span
        p = req.project
        try:
            slots = build_slots(p, req.music_clip_id, span, style)
        except OpsError as exc:
            raise JobFailed(exc.code, exc.message) from exc
        if not slots:
            raise JobFailed("no_slots", "Не удалось построить слоты по маркерам")
        analyses = await self._analyses(ctx, llm, inp.assets)
        cands = build_candidates(inp.assets, analyses)
        rng = random.Random(SEED)

        warnings: list[str] = []
        plan: Plan | None = None
        if llm is not None:
            ctx.progress(0.7, "Gemini подбирает моменты")
            try:
                resp = await llm.generate(
                    GeminiAutoEditResponse,
                    [TextPart(slots_prompt(slots, cands, style, list(self.presets.values()), self.registry))],
                    system=SYSTEM_PROMPT,
                    tier="pro",
                    prompt_version=PROMPT_VERSION,
                )
                plan, warnings = plan_from_gemini(resp, slots, cands, self.presets, self.registry)
            except LLMError as exc:
                log.warning("Автоэдит: Gemini недоступен (%s), жадное назначение", exc.code)
                warnings.append(f"Gemini недоступен ({exc.message}) — моменты подобраны автоматически")
        if plan is None:
            plan = Plan(assign_greedy(slots, cands), style_ramps(slots, style, self.presets, rng), [], False)

        ctx.progress(0.9, "Сборка ops")
        raw: list[dict[str, Any]] = [
            {
                "op": "addTrack",
                "track": {
                    "id": VIDEO_TRACK,
                    "kind": "video",
                    "name": f"Автоэдит: {style.name}",
                    "muted": False,
                    "locked": False,
                    "hidden": False,
                },
            }
        ]
        raw += [
            {
                "op": "addClip",
                "trackId": VIDEO_TRACK,
                "clip": clip_for_slot(s, plan.assignment[s.id], plan.ramps.get(s.id)),
            }
            for s in slots
        ]
        transitions = transition_ops(slots, style, self.registry, req.intensity, rng)
        effects, used = effect_ops(
            p, req.music_clip_id, span, style, plan.suggestions, self.registry, req.intensity, rng
        )
        raw += transitions + effects + global_ops(span, style, self.registry, req.intensity)

        ops, skipped = validate(p, raw, self.registry, lambda a: self._asset(p, a))
        n_trans = max(0, len(transitions) - 1)
        result: dict[str, Any] = {
            "ops": [dump_op(op) for op in ops],
            "explanation": explain(slots, len(plan.ramps), used, n_trans, plan.ai),
        }
        if warnings + skipped:
            result["warnings"] = warnings + skipped
        return result
