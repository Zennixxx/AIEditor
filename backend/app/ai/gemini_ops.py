"""Схема ops для Gemini и перевод в строгий EditOp — docs/BACKEND.md §7.4.

Gemini отвечает по упрощённой схеме: union моделей по `op` с плоскими полями в snake_case (обязательные
поля обязательны — иначе при генерации по схеме модель их пропускает), без вложенных union
(`MarkerFilter.range` → `range_start`/`range_end`, цели → `target` + id), а параметры эффектов — список
строковых пар `{key, value}`, которые приводятся к типам реестра. Перед переводом ответ нормализуется
в плоский `GeminiOp`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from app.ai.timeline import OpsError, filter_markers
from app.ai.validate_ops import DryRun
from app.effects.registry import COLOR_RE, Registry
from app.models.gen import Clip, MarkerFilter, RampPreset
from app.models.ops import StrictEditOp, parse_op

type GOpName = Literal[
    "addTrack",
    "removeTrack",
    "updateTrack",
    "moveTrack",
    "addClip",
    "updateClip",
    "moveClip",
    "splitClip",
    "removeClip",
    "setTimeRemap",
    "addMarkers",
    "updateMarker",
    "removeMarkers",
    "setSections",
    "addEffect",
    "updateEffect",
    "removeEffect",
    "applyEffectToMarkers",
    "cutToMarkers",
    "snapClipEdgesToMarkers",
]
type GMarkerKind = Literal["bass", "beat", "downbeat", "onset", "manual", "ai"]
type GSectionLabel = Literal["intro", "verse", "build", "drop", "break", "outro", "other"]
type GEase = Literal["linear", "hold", "easeIn", "easeOut", "easeInOut"]

DEFAULT_TRACK_NAMES = {"video": "V AI", "audio": "A AI", "fx": "FX: AI"}
DEFAULT_IMAGE_DURATION = 5.0
DEFAULT_SNAP_SHIFT = 0.1


class GParam(BaseModel):
    key: str
    value: str


class GEnvelope(BaseModel):
    attack: float | None = None
    hold: float | None = None
    decay: float | None = None
    curve: Literal["linear", "exp", "easeOut"] | None = None


class GFilter(BaseModel):
    music_clip_id: str | None = None
    kinds: list[GMarkerKind] | None = None
    min_strength: float | None = None
    max_strength: float | None = None
    every: int | None = None
    offset: int | None = None
    section_labels: list[GSectionLabel] | None = None
    range_start: float | None = None
    range_end: float | None = None


class GRampKey(BaseModel):
    u: float
    speed: float
    ease: GEase


class GMarker(BaseModel):
    t: float
    kind: GMarkerKind
    strength: float
    label: str | None = None


class GSection(BaseModel):
    start: float
    end: float
    label: GSectionLabel
    energy: float
    description: str | None = None


class GeminiOp(BaseModel):
    op: GOpName
    id: str | None = None
    target: Literal["track", "clip", "project", "newFxTrack", "clipsUnderMarker"] | None = None
    track_id: str | None = None
    clip_id: str | None = None
    marker_id: str | None = None
    effect_id: str | None = None
    asset_id: str | None = None
    clip_ids: list[str] | None = None
    marker_ids: list[str] | None = None
    track_kind: Literal["video", "audio", "fx"] | None = None
    name: str | None = None
    index: int | None = None
    start: float | None = None
    duration: float | None = None
    at: float | None = None
    source_in: float | None = None
    source_out: float | None = None
    speed: float | None = None
    reverse: bool | None = None
    ripple: bool | None = None
    muted: bool | None = None
    hidden: bool | None = None
    locked: bool | None = None
    volume: float | None = None
    opacity: float | None = None
    enabled: bool | None = None
    label: str | None = None
    color: str | None = None
    effect: str | None = None
    params: list[GParam] | None = None
    envelope: GEnvelope | None = None
    scale_by_strength: bool | None = None
    filter: GFilter | None = None
    order: Literal["sequential", "random", "bestMoments"] | None = None
    seed: int | None = None
    max_shift: float | None = None
    ramp_preset: str | None = None
    keyframes: list[GRampKey] | None = None
    fit: Literal["stretch", "free"] | None = None
    frame_blend: bool | None = None
    clear: bool | None = None
    markers: list[GMarker] | None = None
    sections: list[GSection] | None = None
    t: float | None = None
    strength: float | None = None
    kind: GMarkerKind | None = None


class GAddTrack(BaseModel):
    op: Literal["addTrack"]
    track_kind: Literal["video", "audio", "fx"]
    id: str | None = None
    name: str | None = None
    index: int | None = None


class GRemoveTrack(BaseModel):
    op: Literal["removeTrack"]
    track_id: str


class GUpdateTrack(BaseModel):
    op: Literal["updateTrack"]
    track_id: str
    name: str | None = None
    muted: bool | None = None
    hidden: bool | None = None
    locked: bool | None = None
    volume: float | None = None


class GMoveTrack(BaseModel):
    op: Literal["moveTrack"]
    track_id: str
    index: int


class GAddClip(BaseModel):
    op: Literal["addClip"]
    track_id: str
    asset_id: str
    start: float
    id: str | None = None
    source_in: float | None = None
    source_out: float | None = None
    duration: float | None = None
    speed: float | None = None


class GUpdateClip(BaseModel):
    op: Literal["updateClip"]
    clip_id: str
    speed: float | None = None
    reverse: bool | None = None
    source_in: float | None = None
    source_out: float | None = None
    duration: float | None = None
    opacity: float | None = None
    volume: float | None = None
    label: str | None = None
    color: str | None = None


class GMoveClip(BaseModel):
    op: Literal["moveClip"]
    clip_id: str
    start: float
    track_id: str | None = None


class GSplitClip(BaseModel):
    op: Literal["splitClip"]
    clip_id: str
    at: float


class GRemoveClip(BaseModel):
    op: Literal["removeClip"]
    clip_id: str
    ripple: bool | None = None


class GSetTimeRemap(BaseModel):
    op: Literal["setTimeRemap"]
    clip_id: str
    ramp_preset: str | None = None
    keyframes: list[GRampKey] | None = None
    fit: Literal["stretch", "free"] | None = None
    frame_blend: bool | None = None
    clear: bool | None = None


class GAddMarkers(BaseModel):
    op: Literal["addMarkers"]
    target: Literal["project", "clip"]
    clip_id: str | None = Field(None, description="только при target=clip")
    markers: list[GMarker]


class GUpdateMarker(BaseModel):
    op: Literal["updateMarker"]
    marker_id: str
    t: float | None = None
    kind: GMarkerKind | None = None
    strength: float | None = None
    label: str | None = None
    color: str | None = None


class GRemoveMarkers(BaseModel):
    op: Literal["removeMarkers"]
    marker_ids: list[str] | None = None
    filter: GFilter | None = None


class GSetSections(BaseModel):
    op: Literal["setSections"]
    sections: list[GSection]


class GAddEffect(BaseModel):
    op: Literal["addEffect"]
    effect: str
    target: Literal["track", "clip"]
    target_id: str = Field(description="id fx-дорожки (target=track) или клипа (target=clip), можно tmp_")
    start: float
    duration: float | None = None
    params: list[GParam] | None = None
    envelope: GEnvelope | None = None
    id: str | None = None


class GUpdateEffect(BaseModel):
    op: Literal["updateEffect"]
    effect_id: str
    start: float | None = None
    duration: float | None = None
    params: list[GParam] | None = None
    envelope: GEnvelope | None = None
    enabled: bool | None = None


class GRemoveEffect(BaseModel):
    op: Literal["removeEffect"]
    effect_id: str


class GApplyEffectToMarkers(BaseModel):
    op: Literal["applyEffectToMarkers"]
    effect: str
    filter: GFilter
    target: Literal["newFxTrack", "clipsUnderMarker", "track"]
    track_id: str | None = Field(None, description="только при target=track: id существующей fx-дорожки")
    params: list[GParam] | None = None
    duration: float | None = None
    envelope: GEnvelope | None = None
    scale_by_strength: bool | None = None


class GCutToMarkers(BaseModel):
    op: Literal["cutToMarkers"]
    clip_ids: list[str]
    filter: GFilter
    order: Literal["sequential", "random", "bestMoments"]
    track_id: str | None = None
    seed: int | None = None


class GSnapClipEdgesToMarkers(BaseModel):
    op: Literal["snapClipEdgesToMarkers"]
    clip_ids: list[str]
    filter: GFilter
    max_shift: float


type GOp = (
    GAddTrack
    | GRemoveTrack
    | GUpdateTrack
    | GMoveTrack
    | GAddClip
    | GUpdateClip
    | GMoveClip
    | GSplitClip
    | GRemoveClip
    | GSetTimeRemap
    | GAddMarkers
    | GUpdateMarker
    | GRemoveMarkers
    | GSetSections
    | GAddEffect
    | GUpdateEffect
    | GRemoveEffect
    | GApplyEffectToMarkers
    | GCutToMarkers
    | GSnapClipEdgesToMarkers
)


class GeminiCommandResponse(BaseModel):
    ops: list[GOp]
    explanation: str


class ConversionError(Exception):
    pass


@dataclass
class ConvertContext:
    dry: DryRun
    registry: Registry
    ramp_presets: dict[str, RampPreset]
    selected_clip_ids: list[str]
    warnings: list[str] = field(default_factory=list)


def _need[V](value: V | None, name: str, op: str) -> V:
    if value is None:
        raise ConversionError(f"{op}: не задано поле {name}")
    return value


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def convert_params(ctx: ConvertContext, effect: str, params: list[GParam] | None) -> dict[str, Any]:
    definition = ctx.registry.effects.get(effect)
    if definition is None:
        raise ConversionError(f"неизвестный эффект {effect!r}; допустимы только id из реестра")
    defs = {p.key: p for p in definition.params}
    out: dict[str, Any] = {}
    for gp in params or []:
        p = defs.get(gp.key)
        if p is None:
            ctx.warnings.append(f"У эффекта {effect} нет параметра {gp.key} — пропущен")
            continue
        raw = gp.value.strip()
        match p.type:
            case "number":
                try:
                    v = float(raw.rstrip("%").replace(",", "."))
                except ValueError as exc:
                    raise ConversionError(f"{effect}.{p.key} = {raw!r}: ожидается число") from exc
                if not math.isfinite(v):
                    raise ConversionError(f"{effect}.{p.key} = {raw!r}: ожидается конечное число")
                lo = p.min if p.min is not None else -math.inf
                hi = p.max if p.max is not None else math.inf
                if not lo <= v <= hi:
                    clamped = min(max(v, lo), hi)
                    ctx.warnings.append(
                        f"{effect}.{p.key} = {v:g} вне {p.min:g}..{p.max:g} — взято {clamped:g}"
                    )
                    v = clamped
                out[p.key] = v
            case "boolean":
                low = raw.lower()
                if low not in ("true", "false", "1", "0", "yes", "no"):
                    raise ConversionError(f"{effect}.{p.key} = {raw!r}: ожидается true/false")
                out[p.key] = low in ("true", "1", "yes")
            case "color":
                if not COLOR_RE.match(raw):
                    raise ConversionError(f"{effect}.{p.key} = {raw!r}: ожидается цвет #rrggbb")
                out[p.key] = raw
            case "enum":
                if raw not in (p.options or []):
                    raise ConversionError(f"{effect}.{p.key} = {raw!r}: допустимо {p.options}")
                out[p.key] = raw
    return out


def convert_filter(g: GFilter | None) -> dict[str, Any]:
    if g is None:
        return {}
    rng = None
    if g.range_start is not None or g.range_end is not None:
        rng = {"start": g.range_start if g.range_start is not None else 0.0,
               "end": g.range_end if g.range_end is not None else 1e9}  # fmt: skip
    return _drop_none(
        {
            "musicClipId": g.music_clip_id,
            "kinds": g.kinds,
            "minStrength": g.min_strength,
            "every": g.every,
            "offset": g.offset,
            "sectionLabels": g.section_labels,
            "range": rng,
        }
    )


def _envelope_patch(g: GEnvelope | None) -> dict[str, Any] | None:
    if g is None:
        return None
    patch = _drop_none(g.model_dump())
    return patch or None


def _full_envelope(
    ctx: ConvertContext, effect: str, g: GEnvelope | None, base: dict[str, Any] | None = None
) -> dict:
    definition = ctx.registry.effects[effect]
    env = base or definition.default_envelope.model_dump()
    env.update(_envelope_patch(g) or {})
    return env


def _clip_ids(ctx: ConvertContext, g: GeminiOp) -> list[str]:
    ids = g.clip_ids or ([g.clip_id] if g.clip_id else None) or ctx.selected_clip_ids
    if not ids:
        raise ConversionError(f"{g.op}: не заданы clip_ids и нет выделенных клипов")
    return ids


def _time_remap(ctx: ConvertContext, g: GeminiOp) -> dict[str, Any] | None:
    if g.clear:
        return None
    if g.ramp_preset:
        preset = ctx.ramp_presets.get(g.ramp_preset)
        if preset is None:
            raise ConversionError(
                f"setTimeRemap: неизвестный пресет {g.ramp_preset!r}; есть {sorted(ctx.ramp_presets)}"
            )
        remap = preset.time_remap.model_dump(mode="json", by_alias=True)
        if g.frame_blend is not None:
            remap["frameBlend"] = g.frame_blend
        return remap
    keys = _need(g.keyframes, "keyframes или ramp_preset", g.op)
    keys = sorted(keys, key=lambda k: k.u)
    return {
        "keyframes": [{"u": k.u, "speed": k.speed, "ease": k.ease} for k in keys],
        "fit": g.fit or "stretch",
        "frameBlend": True if g.frame_blend is None else g.frame_blend,
    }


def _clip_slot_patch(clip: Clip, g: GeminiOp) -> dict[str, Any]:
    patch = _drop_none(
        {
            "start": g.start,
            "duration": g.duration,
            "sourceIn": g.source_in,
            "sourceOut": g.source_out,
            "speed": g.speed,
            "reverse": g.reverse,
            "opacity": g.opacity,
            "volume": g.volume,
            "label": g.label,
            "color": g.color,
        }
    )
    timing = {"duration", "sourceIn", "sourceOut", "speed"} & patch.keys()
    if clip.time_remap is None and timing and "duration" not in patch:
        src_in = patch.get("sourceIn", clip.source_in)
        src_out = patch.get("sourceOut", clip.source_out)
        speed = patch.get("speed", clip.speed)
        patch["duration"] = (src_out - src_in) / speed
    elif clip.time_remap is None and "duration" in patch and not timing - {"duration"}:
        patch["sourceOut"] = clip.source_in + patch["duration"] * clip.speed
    return patch


def _add_clip(ctx: ConvertContext, g: GeminiOp) -> dict[str, Any]:
    asset = ctx.dry.asset(_need(g.asset_id, "asset_id", g.op))
    speed = g.speed or 1.0
    source_in = g.source_in or 0.0
    if asset.kind == "image":
        duration = g.duration or DEFAULT_IMAGE_DURATION
        source_out = source_in + duration * speed
    else:
        source_out = g.source_out if g.source_out is not None else asset.duration
        if g.duration is not None and g.source_out is None:
            source_out = min(asset.duration, source_in + g.duration * speed)
        duration = (source_out - source_in) / speed
    clip: dict[str, Any] = {
        "id": g.id,
        "type": "clip",
        "assetId": asset.id,
        "start": _need(g.start, "start", g.op),
        "duration": duration,
        "sourceIn": source_in,
        "sourceOut": source_out,
        "speed": speed,
        "reverse": bool(g.reverse),
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "anchorX": 0, "anchorY": 0},
        "opacity": 1 if g.opacity is None else g.opacity,
        "blendMode": "normal",
        "effects": [],
        "markers": [],
    }
    if asset.has_audio:
        clip["volume"] = 1 if g.volume is None else g.volume
    if g.label:
        clip["label"] = g.label
    return {"op": "addClip", "trackId": _need(g.track_id, "track_id", g.op), "clip": _drop_none(clip)}


def _effect_target(g: GeminiOp) -> dict[str, str]:
    if g.target == "clip" or (g.target is None and g.clip_id and not g.track_id):
        return {"clipId": _need(g.clip_id, "clip_id", g.op)}
    return {"trackId": _need(g.track_id, "track_id", g.op)}


def _remove_markers(ctx: ConvertContext, g: GeminiOp) -> dict[str, Any]:
    if g.marker_ids:
        return {"op": "removeMarkers", "markerIds": g.marker_ids}
    if g.filter is None:
        raise ConversionError("removeMarkers: нужны marker_ids или filter")
    f = MarkerFilter.model_validate(convert_filter(g.filter))
    try:
        found = filter_markers(ctx.dry.project, f, g.filter.max_strength)
    except OpsError as exc:
        raise ConversionError(f"removeMarkers: {exc.message}") from exc
    if not found:
        raise ConversionError("removeMarkers: фильтр не нашёл ни одного маркера")
    return {"op": "removeMarkers", "markerIds": [tm.marker.id for tm in found]}


def to_raw_op(ctx: ConvertContext, g: GeminiOp) -> dict[str, Any]:
    match g.op:
        case "addTrack":
            kind = _need(g.track_kind, "track_kind", g.op)
            track = {
                "id": g.id,
                "kind": kind,
                "name": g.name or DEFAULT_TRACK_NAMES[kind],
                "muted": bool(g.muted),
                "locked": bool(g.locked),
                "hidden": bool(g.hidden),
                "volume": (1.0 if g.volume is None else g.volume) if kind == "audio" else None,
            }
            return _drop_none({"op": "addTrack", "track": _drop_none(track), "index": g.index})
        case "removeTrack":
            return {"op": "removeTrack", "trackId": _need(g.track_id, "track_id", g.op)}
        case "updateTrack":
            patch = _drop_none(
                {"name": g.name, "muted": g.muted, "locked": g.locked, "hidden": g.hidden, "volume": g.volume}
            )
            return {"op": "updateTrack", "trackId": _need(g.track_id, "track_id", g.op), "patch": patch}
        case "moveTrack":
            return {
                "op": "moveTrack",
                "trackId": _need(g.track_id, "track_id", g.op),
                "index": _need(g.index, "index", g.op),
            }
        case "addClip":
            return _add_clip(ctx, g)
        case "updateClip":
            clip_id = _need(g.clip_id, "clip_id", g.op)
            _, clip, _ = ctx.dry.clip(clip_id)
            return {"op": "updateClip", "clipId": clip_id, "patch": _clip_slot_patch(clip, g)}
        case "moveClip":
            return _drop_none(
                {"op": "moveClip", "clipId": _need(g.clip_id, "clip_id", g.op),
                 "start": _need(g.start, "start", g.op), "trackId": g.track_id}
            )  # fmt: skip
        case "splitClip":
            return {
                "op": "splitClip",
                "clipId": _need(g.clip_id, "clip_id", g.op),
                "at": _need(g.at, "at", g.op),
            }
        case "removeClip":
            return _drop_none(
                {"op": "removeClip", "clipId": _need(g.clip_id, "clip_id", g.op), "ripple": g.ripple}
            )
        case "setTimeRemap":
            return {
                "op": "setTimeRemap",
                "clipId": _need(g.clip_id, "clip_id", g.op),
                "timeRemap": _time_remap(ctx, g),
            }
        case "addMarkers":
            markers = _need(g.markers, "markers", g.op)
            target: Any = "project" if g.target == "project" or not g.clip_id else {"clipId": g.clip_id}
            return {
                "op": "addMarkers",
                "target": target,
                "markers": [_drop_none(m.model_dump()) for m in markers],
            }
        case "updateMarker":
            patch = _drop_none(
                {"t": g.t, "kind": g.kind, "strength": g.strength, "label": g.label, "color": g.color}
            )
            return {"op": "updateMarker", "markerId": _need(g.marker_id, "marker_id", g.op), "patch": patch}
        case "removeMarkers":
            return _remove_markers(ctx, g)
        case "setSections":
            target = "project" if g.target == "project" or not g.clip_id else {"clipId": g.clip_id}
            return {
                "op": "setSections",
                "target": target,
                "sections": [_drop_none(s.model_dump()) for s in g.sections or []],
            }
        case "addEffect":
            effect = _need(g.effect, "effect", g.op)
            params = convert_params(ctx, effect, g.params)
            definition = ctx.registry.effects[effect]
            return {
                "op": "addEffect",
                "target": _effect_target(g),
                "effect": _drop_none(
                    {
                        "id": g.id,
                        "effect": effect,
                        "start": _need(g.start, "start", g.op),
                        "duration": g.duration or definition.default_duration,
                        "params": params,
                        "envelope": _full_envelope(ctx, effect, g.envelope),
                        "enabled": True if g.enabled is None else g.enabled,
                    }
                ),
            }
        case "updateEffect":
            effect_id = _need(g.effect_id, "effect_id", g.op)
            current = ctx.dry.effect(effect_id).effect
            effect = g.effect or current.effect
            patch: dict[str, Any] = _drop_none(
                {"start": g.start, "duration": g.duration, "enabled": g.enabled,
                 "effect": g.effect if g.effect and g.effect != current.effect else None}
            )  # fmt: skip
            if g.params:
                patch["params"] = {**current.params, **convert_params(ctx, effect, g.params)}
            if g.envelope:
                patch["envelope"] = _full_envelope(ctx, effect, g.envelope, current.envelope.model_dump())
            return {"op": "updateEffect", "effectId": effect_id, "patch": patch}
        case "removeEffect":
            return {"op": "removeEffect", "effectId": _need(g.effect_id, "effect_id", g.op)}
        case "applyEffectToMarkers":
            effect = _need(g.effect, "effect", g.op)
            params = convert_params(ctx, effect, g.params)
            if g.target == "clipsUnderMarker":
                target = "clipsUnderMarker"
            elif g.track_id and g.target in (None, "track"):
                target = {"trackId": g.track_id}
            else:
                target = "newFxTrack"
            return _drop_none(
                {
                    "op": "applyEffectToMarkers",
                    "effect": effect,
                    "params": params or None,
                    "envelope": _envelope_patch(g.envelope),
                    "duration": g.duration,
                    "scaleByStrength": g.scale_by_strength,
                    "filter": convert_filter(g.filter),
                    "target": target,
                }
            )
        case "cutToMarkers":
            return _drop_none(
                {"op": "cutToMarkers", "clipIds": _clip_ids(ctx, g), "filter": convert_filter(g.filter),
                 "trackId": g.track_id, "order": g.order or "sequential", "seed": g.seed}
            )  # fmt: skip
        case "snapClipEdgesToMarkers":
            return {
                "op": "snapClipEdgesToMarkers",
                "clipIds": _clip_ids(ctx, g),
                "filter": convert_filter(g.filter),
                "maxShift": g.max_shift if g.max_shift and g.max_shift > 0 else DEFAULT_SNAP_SHIFT,
            }


def convert(ctx: ConvertContext, gop: GOp) -> StrictEditOp:
    data = gop.model_dump()
    if "target_id" in data:
        data["track_id" if data["target"] == "track" else "clip_id"] = data.pop("target_id")
    g = GeminiOp.model_validate(data)
    try:
        raw = to_raw_op(ctx, g)
    except OpsError as exc:
        raise ConversionError(f"{g.op}: {exc.message}") from exc
    try:
        return parse_op(raw)
    except ValidationError as exc:
        msgs = "; ".join(
            f"{'.'.join(str(x) for x in e['loc'][1:])}: {e['msg']}" for e in exc.errors(include_url=False)[:5]
        )
        raise ConversionError(f"{g.op}: {msgs}") from exc
