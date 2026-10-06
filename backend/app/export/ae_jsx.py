from __future__ import annotations

import itertools
import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.effects.registry import Registry
from app.models.gen import (
    Animatable,
    Asset,
    BezierEase,
    Clip,
    Ease,
    EffectItem,
    Keyframe,
    Marker,
    Project,
    RampKeyframe,
    Section,
    Track,
)
from app.timeremap import NAMED_BEZIER, EaseSpec, RampKey, solve, source_time

MIN_INFLUENCE = 0.1
EDGE = 1e-3
EPS = 1e-9
SILENCE_DB = -96.0
INLINE_WIDTH = 110

MESSAGES = {
    "missingFile": "Файл не найден",
    "importFailed": "Не удалось импортировать",
    "missingLayer": "НЕТ ФАЙЛА",
    "folder": "AIEditor",
    "summary": "AIEditor: экспорт завершён с предупреждениями",
}

type AnimSpec = float | list[dict[str, Any]]


def _num(x: float) -> float:
    r = round(float(x), 6)
    return 0.0 if r == 0 else r


def _fmt(v: float | str | bool) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int | float):
        return f"{v:g}"
    return v


def _bezier(ease: Ease) -> tuple[float, float, float, float] | None:
    if isinstance(ease, BezierEase):
        x1, y1, x2, y2 = ease.bezier
        return (x1, y1, x2, y2)
    return NAMED_BEZIER.get(ease)


def _interp(ease: Ease) -> str:
    if ease == "hold":
        return "hold"
    if ease == "linear":
        return "linear"
    return "bezier"


def _out_ease(b: tuple[float, float, float, float], avg: float) -> tuple[float, float]:
    x1, y1, x2, y2 = b
    if x1 > EDGE:
        return avg * y1 / x1, max(MIN_INFLUENCE, min(100.0, x1 * 100))
    slope = y2 / x2 if x2 > EDGE else 1.0
    return avg * slope, MIN_INFLUENCE


def _in_ease(b: tuple[float, float, float, float], avg: float) -> tuple[float, float]:
    x1, y1, x2, y2 = b
    if 1 - x2 > EDGE:
        return avg * (1 - y2) / (1 - x2), max(MIN_INFLUENCE, min(100.0, (1 - x2) * 100))
    slope = (1 - y1) / (1 - x1) if 1 - x1 > EDGE else 1.0
    return avg * slope, MIN_INFLUENCE


def anim_spec(
    value: Animatable,
    t0: float,
    fn: Callable[[float], float] = lambda v: v,
    eased: bool = True,
) -> AnimSpec:
    if isinstance(value, int | float):
        return _num(fn(value))
    keys: list[Keyframe] = sorted(value, key=lambda k: k.t)
    if len(keys) == 1:
        return _num(fn(keys[0].v))
    out: list[dict[str, Any]] = [
        {"t": _num(t0 + k.t), "v": _num(fn(k.v)), "i": "linear", "o": "linear"} for k in keys
    ]
    for i, (a, b) in enumerate(itertools.pairwise(keys)):
        kind = _interp(a.ease)
        if kind == "bezier" and not eased:
            kind = "linear"
        out[i]["o"] = kind
        if kind != "bezier":
            continue
        out[i + 1]["i"] = "bezier"
        curve = _bezier(a.ease)
        assert curve is not None
        dt = b.t - a.t
        avg = (fn(b.v) - fn(a.v)) / dt if dt > EPS else 0.0
        speed, influence = _out_ease(curve, avg)
        out[i]["oS"], out[i]["oI"] = _num(speed), _num(influence)
        speed, influence = _in_ease(curve, avg)
        out[i + 1]["iS"], out[i + 1]["iI"] = _num(speed), _num(influence)
    return out


def _ramp_ease(ease: Ease) -> EaseSpec:
    if isinstance(ease, BezierEase):
        x1, y1, x2, y2 = ease.bezier
        return (x1, y1, x2, y2)
    return ease


def _ramp_keys(keys: Sequence[RampKeyframe]) -> list[RampKey]:
    return [RampKey(u=k.u, speed=k.speed, ease=_ramp_ease(k.ease)) for k in keys]


@dataclass(slots=True)
class ClipTiming:
    start: float
    duration: float
    source_in: float
    source_out: float
    plain: bool
    samples: list[tuple[float, float]]

    def comp_of_source(self, t: float) -> float | None:
        if self.plain:
            if self.source_in - EPS <= t <= self.source_out + EPS:
                return self.start + (t - self.source_in)
            return None
        for (ta, sa), (tb, sb) in itertools.pairwise(self.samples):
            lo, hi = min(sa, sb), max(sa, sb)
            if lo - EPS <= t <= hi + EPS:
                p = 0.0 if abs(sb - sa) < EPS else (t - sa) / (sb - sa)
                return self.start + ta + (tb - ta) * min(max(p, 0.0), 1.0)
        return None


def clip_timing(clip: Clip, fps: float) -> ClipTiming:
    d = clip.duration
    if clip.time_remap is None:
        source_out = clip.source_in + clip.speed * d
        plain = abs(clip.speed - 1) < EPS and not clip.reverse
        ends = [clip.source_in, source_out]
        if clip.reverse:
            ends.reverse()
        return ClipTiming(clip.start, d, clip.source_in, source_out, plain, [(0.0, ends[0]), (d, ends[1])])
    remap = clip.time_remap
    keys = _ramp_keys(remap.keyframes)
    res = solve(keys, remap.fit, d, clip.source_in, clip.source_out)
    count = math.floor(d * fps + EPS)
    taus = [j / fps for j in range(count + 1)]
    if d - taus[-1] > EPS:
        taus.append(d)
    samples = [
        (tau, source_time(keys, remap.fit, d, clip.source_in, clip.source_out, tau, clip.reverse))
        for tau in taus
    ]
    return ClipTiming(clip.start, d, clip.source_in, res.source_out, False, samples)


def _db(v: float) -> float:
    return SILENCE_DB if v <= 1e-5 else max(SILENCE_DB, 20 * math.log10(v))


def _marker_comment(m: Marker) -> str:
    text = f"{m.kind} {m.strength:.2f}"
    return f"{text} {m.label}" if m.label else text


def _section_comment(s: Section) -> str:
    text = f"section: {s.label} energy={s.energy:.2f}"
    return f"{text} {s.description}" if s.description else text


def effect_comment(e: EffectItem, registry: Registry | None) -> str:
    definition = registry.effects.get(e.effect) if registry else None
    params: dict[str, float | str | bool] = {}
    if definition:
        params.update({p.key: p.default for p in definition.params})
    params.update(e.params)
    head = f"fx: {e.effect}"
    if definition:
        head += f" ({definition.name})"
    body = " ".join(f"{k}={_fmt(v)}" for k, v in params.items())
    env = e.envelope
    tail = f"env {_fmt(env.attack)}/{_fmt(env.hold)}/{_fmt(env.decay)} {env.curve}"
    parts = [head, body, "|", tail] if body else [head, "|", tail]
    if not e.enabled:
        parts.append("[off]")
    return " ".join(parts)


def _marker(t: float, comment: str, duration: float = 0.0) -> dict[str, Any]:
    out: dict[str, Any] = {"t": _num(t), "c": comment}
    if duration > EPS:
        out["d"] = _num(duration)
    return out


def _clip_markers(clip: Clip, timing: ClipTiming, registry: Registry | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in clip.markers:
        t = timing.comp_of_source(m.t)
        if t is not None:
            out.append(_marker(t, _marker_comment(m)))
    for s in clip.sections or []:
        a = timing.comp_of_source(max(s.start, min(timing.source_in, timing.source_out)))
        b = timing.comp_of_source(min(s.end, max(timing.source_in, timing.source_out)))
        if a is None or b is None:
            continue
        lo, hi = min(a, b), max(a, b)
        if hi - lo > EPS:
            out.append(_marker(lo, _section_comment(s), hi - lo))
    for e in clip.effects:
        out.append(_marker(clip.start + e.start, effect_comment(e, registry), e.duration))
    out.sort(key=lambda m: m["t"])
    return out


def _clip_layer(
    clip: Clip, track: Track, asset: Asset, fps: float, registry: Registry | None
) -> dict[str, Any]:
    timing = clip_timing(clip, fps)
    layer: dict[str, Any] = {
        "name": clip.label or asset.name,
        "asset": asset.id,
        "kind": asset.kind,
        "in": _num(clip.start),
        "out": _num(clip.start + clip.duration),
        "startTime": _num(clip.start if asset.kind == "image" else clip.start - clip.source_in),
        "remap": None,
        "enabled": not track.hidden,
        "audio": not track.muted,
        "locked": track.locked,
        "blend": clip.blend_mode,
        "transform": None,
        "levels": None,
        "markers": _clip_markers(clip, timing, registry),
    }
    if asset.kind != "image" and not timing.plain:
        layer["startTime"] = _num(clip.start)
        layer["remap"] = [[_num(clip.start + tau), _num(src)] for tau, src in timing.samples]
    if track.kind == "video":
        tr = clip.transform
        layer["transform"] = {
            "anchorX": _num(tr.anchor_x),
            "anchorY": _num(tr.anchor_y),
            "x": anim_spec(tr.x, clip.start),
            "y": anim_spec(tr.y, clip.start),
            "scale": anim_spec(tr.scale, clip.start),
            "rotation": anim_spec(tr.rotation, clip.start),
            "opacity": anim_spec(clip.opacity, clip.start),
        }
    has_sound = asset.kind == "audio" or (asset.kind == "video" and asset.has_audio)
    if has_sound:
        gain = track.volume if track.kind == "audio" and track.volume is not None else 1.0
        volume = clip.volume if clip.volume is not None else 1.0
        layer["levels"] = anim_spec(volume, clip.start, lambda v: _db(v * gain), eased=False)
    return layer


def _fx_layer(track: Track, duration: float, registry: Registry | None) -> dict[str, Any]:
    markers = [
        _marker(e.start, effect_comment(e, registry), e.duration)
        for e in track.items
        if isinstance(e, EffectItem)
    ]
    return {
        "name": f"FX: {track.name}",
        "adjustment": True,
        "in": 0.0,
        "out": _num(duration),
        "enabled": not track.hidden,
        "locked": track.locked,
        "markers": markers,
    }


def _color(hex_color: str) -> list[float]:
    h = hex_color.lstrip("#")
    if len(h) < 6:
        return [0.0, 0.0, 0.0]
    return [_num(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4)]


def ae_data(project: Project, registry: Registry | None = None) -> dict[str, Any]:
    duration = max(project.duration, 1 / project.fps)
    assets = {a.id: a for a in project.assets}
    used: list[str] = []
    layers: list[dict[str, Any]] = []
    for track in project.tracks:
        if track.kind == "fx":
            if any(isinstance(i, EffectItem) for i in track.items):
                layers.append(_fx_layer(track, duration, registry))
            continue
        for item in track.items:
            if not isinstance(item, Clip):
                continue
            asset = assets.get(item.asset_id)
            if asset is None:
                continue
            if asset.id not in used:
                used.append(asset.id)
            layers.append(_clip_layer(item, track, asset, project.fps, registry))
    comp_markers = [_marker(m.t, _marker_comment(m)) for m in project.markers]
    comp_markers += [_marker(s.start, _section_comment(s), s.end - s.start) for s in project.sections]
    comp_markers.sort(key=lambda m: m["t"])
    return {
        "comp": {
            "name": project.name,
            "width": project.width,
            "height": project.height,
            "fps": project.fps,
            "duration": _num(duration),
            "background": _color(project.background),
            "markers": comp_markers,
        },
        "assets": [
            {
                "id": a.id,
                "name": a.name,
                "path": a.path,
                "kind": a.kind,
                "width": a.width,
                "height": a.height,
            }
            for a in (assets[i] for i in used)
        ],
        "layers": layers,
        "messages": MESSAGES,
    }


PRELUDE = (Path(__file__).parent / "ae_prelude.js").read_text(encoding="utf-8")


def _js(value: Any, level: int = 0) -> str:
    flat = json.dumps(value, ensure_ascii=True, separators=(", ", ": "))
    if not isinstance(value, dict | list) or len(flat) + level * 2 <= INLINE_WIDTH:
        return flat
    pad = "  " * (level + 1)
    end = "\n" + "  " * level
    if isinstance(value, dict):
        items = [f"{pad}{json.dumps(k, ensure_ascii=True)}: {_js(v, level + 1)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + end + "}"
    items = [f"{pad}{_js(v, level + 1)}" for v in value]
    return "[\n" + ",\n".join(items) + end + "]"


def build_ae_jsx(project: Project, registry: Registry | None = None) -> str:
    data = _js(ae_data(project, registry))
    header = "// AIEditor -> After Effects (ExtendScript). File > Scripts > Run Script File...\n"
    return header + "var DATA = " + data + ";\n" + PRELUDE


def content_disposition(filename: str) -> str:
    cleaned = "".join(c for c in filename if c not in '\\/:*?"<>|\r\n').strip() or "project.jsx"
    ascii_name = cleaned.encode("ascii", "replace").decode("ascii").replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(cleaned)}"
