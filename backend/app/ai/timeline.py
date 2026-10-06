"""Время клипа и фильтр маркеров — порт `frontend/src/model/{clipTime,sections,markerFilter}.ts`."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from app.models.gen import Clip, EffectItem, Marker, MarkerFilter, MarkerKind, Project, SectionLabel, Track
from app.timeremap import RampKey, integral, keys_from_json, solve

EPS = 1e-6
DEFAULT_FILTER_KINDS: tuple[MarkerKind, ...] = ("bass",)


class OpsError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def is_clip(item: Clip | EffectItem) -> bool:
    return isinstance(item, Clip)


def item_end(item: Clip | EffectItem) -> float:
    return item.start + item.duration


def iter_clips(p: Project) -> Iterator[tuple[Track, Clip]]:
    for track in p.tracks:
        for item in track.items:
            if isinstance(item, Clip):
                yield track, item


def _keys(clip: Clip) -> list[RampKey]:
    assert clip.time_remap is not None
    return keys_from_json(clip.time_remap.model_dump(mode="json")["keyframes"])


def effective_source_out(clip: Clip) -> float:
    r = clip.time_remap
    if r is None:
        return clip.source_out
    return solve(_keys(clip), r.fit, clip.duration, clip.source_in, clip.source_out).source_out


def forward_source(clip: Clip, tau: float, keys: list[RampKey] | None = None) -> float:
    d = clip.duration
    t = min(max(tau, 0.0), d)
    r = clip.time_remap
    if r is None:
        return clip.source_in + t * clip.speed
    keys = keys or _keys(clip)
    k = solve(keys, r.fit, d, clip.source_in, clip.source_out).k
    return clip.source_in + d * k * integral(keys, t / d)


def timeline_at_source(clip: Clip, src: float) -> float | None:
    out = effective_source_out(clip)
    if src < clip.source_in - EPS or src > out + EPS:
        return None
    target = out - (src - clip.source_in) if clip.reverse else src
    if clip.time_remap is None:
        return clip.start + (target - clip.source_in) / clip.speed
    keys = _keys(clip)
    lo, hi = 0.0, clip.duration
    for _ in range(50):
        mid = (lo + hi) / 2
        if forward_source(clip, mid, keys) < target:
            lo = mid
        else:
            hi = mid
    return clip.start + (lo + hi) / 2


@dataclass(slots=True)
class TimelineMarker:
    marker: Marker
    clip_id: str | None
    t: float


@dataclass(slots=True)
class TimelineSection:
    id: str
    clip_id: str | None
    start: float
    end: float
    label: SectionLabel
    energy: float
    description: str | None = None


def section_span(clip: Clip, start: float, end: float) -> tuple[float, float] | None:
    lo = max(start, clip.source_in)
    hi = min(end, effective_source_out(clip))
    if not hi - lo > EPS:
        return None
    a = timeline_at_source(clip, lo)
    b = timeline_at_source(clip, hi)
    if a is None or b is None:
        return None
    t0, t1 = min(a, b), max(a, b)
    return (t0, t1) if t1 - t0 > EPS else None


def timeline_sections(p: Project) -> list[TimelineSection]:
    res = [TimelineSection(s.id, None, s.start, s.end, s.label, s.energy, s.description) for s in p.sections]
    for _, clip in iter_clips(p):
        for s in clip.sections or []:
            span = section_span(clip, s.start, s.end)
            if span:
                res.append(TimelineSection(s.id, clip.id, span[0], span[1], s.label, s.energy, s.description))
    return sorted(res, key=lambda s: s.start)


def find_clip(p: Project, clip_id: str) -> tuple[Track, Clip, int] | None:
    for track in p.tracks:
        for i, item in enumerate(track.items):
            if item.id == clip_id and isinstance(item, Clip):
                return track, item, i
    return None


def resolve_music_clip(p: Project, music_clip_id: str | None) -> Clip | None:
    if music_clip_id is not None:
        ref = find_clip(p, music_clip_id)
        if ref is None:
            raise OpsError("clip_not_found", f"Музыкальный клип {music_clip_id} не найден")
        return ref[1]
    first: Clip | None = None
    for track in p.tracks:
        if track.kind != "audio":
            continue
        for item in track.items:
            if not isinstance(item, Clip):
                continue
            if item.markers:
                return item
            first = first or item
    return first


def clip_markers_on_timeline(clip: Clip) -> list[TimelineMarker]:
    out: list[TimelineMarker] = []
    for m in clip.markers:
        t = timeline_at_source(clip, m.t)
        if t is not None:
            out.append(TimelineMarker(m, clip.id, t))
    return out


def filter_markers(p: Project, f: MarkerFilter, max_strength: float | None = None) -> list[TimelineMarker]:
    every = f.every if f.every is not None else 1
    offset = f.offset if f.offset is not None else 0
    if every < 1:
        raise OpsError("bad_value", "filter.every должно быть целым ≥ 1")
    if offset < 0:
        raise OpsError("bad_value", "filter.offset должно быть целым ≥ 0")
    if f.min_strength is not None and not 0 <= f.min_strength <= 1:
        raise OpsError("bad_value", "filter.minStrength вне 0..1")
    if f.range is not None and not f.range.start <= f.range.end:
        raise OpsError("bad_value", "filter.range: start должен быть ≤ end")

    kinds = f.kinds if f.kinds is not None else DEFAULT_FILTER_KINDS
    music = resolve_music_clip(p, f.music_clip_id)
    if music is not None:
        items = clip_markers_on_timeline(music)
    else:
        items = [TimelineMarker(m, None, m.t) for m in p.markers]

    labels = f.section_labels
    sections = (
        [
            s
            for s in timeline_sections(p)
            if s.label in labels and (s.clip_id is None or (music is not None and s.clip_id == music.id))
        ]
        if labels
        else []
    )
    min_strength = f.min_strength or 0.0

    def keep(tm: TimelineMarker) -> bool:
        m = tm.marker
        if m.kind not in kinds or m.strength < min_strength - 1e-9:
            return False
        if max_strength is not None and m.strength > max_strength + 1e-9:
            return False
        if labels and not any(s.start - EPS <= tm.t < s.end - EPS for s in sections):
            return False
        return not (f.range is not None and not f.range.start - EPS <= tm.t <= f.range.end + EPS)

    items = sorted((tm for tm in items if keep(tm)), key=lambda tm: tm.t)
    return [tm for i, tm in enumerate(items) if i >= offset and (i - offset) % every == 0]


def dedupe_close(markers: list[TimelineMarker], fps: float) -> list[TimelineMarker]:
    frame = 1 / fps
    out: list[TimelineMarker] = []
    for tm in markers:
        if out and tm.t - out[-1].t < frame - EPS:
            continue
        out.append(tm)
    return out


def r3(x: float) -> float:
    return round(x, 3)


def compact(obj: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in obj.items() if v is not None and v != [] and v is not False}
