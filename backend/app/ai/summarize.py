"""Проект → компактный контекст для копилота — docs/BACKEND.md §7.4."""

from __future__ import annotations

from collections import Counter
from typing import Any

from app.ai.timeline import (
    TimelineMarker,
    clip_markers_on_timeline,
    compact,
    item_end,
    r3,
    resolve_music_clip,
    timeline_sections,
)
from app.effects.registry import Registry
from app.models.gen import AICommandRequest, Clip, EffectItem, Project, RampPreset, Track

MAX_LISTED_MARKERS = 200
MAX_TRACK_ITEMS = 60
NEAR_PLAYHEAD_SEC = 15.0
MAX_CLIP_EFFECTS = 12


def _effect(e: EffectItem, offset: float = 0.0) -> dict[str, Any]:
    return compact(
        {
            "id": e.id,
            "effect": e.effect,
            "start": r3(e.start + offset),
            "end": r3(e.start + offset + e.duration),
            "params": e.params or None,
            "off": not e.enabled,
        }
    )


def _clip(c: Clip, assets: dict[str, str]) -> dict[str, Any]:
    return compact(
        {
            "id": c.id,
            "asset": c.asset_id,
            "assetName": assets.get(c.asset_id),
            "start": r3(c.start),
            "end": r3(item_end(c)),
            "sourceIn": r3(c.source_in),
            "sourceOut": r3(c.source_out),
            "speed": r3(c.speed) if c.time_remap is None and abs(c.speed - 1) > 1e-6 else None,
            "reverse": c.reverse,
            "ramp": [r3(k.speed) for k in c.time_remap.keyframes] if c.time_remap else None,
            "label": c.label,
            "effects": [_effect(e, c.start) for e in c.effects[:MAX_CLIP_EFFECTS]] or None,
            "moreEffects": len(c.effects) - MAX_CLIP_EFFECTS if len(c.effects) > MAX_CLIP_EFFECTS else None,
            "markers": len(c.markers) or None,
            "sections": len(c.sections or []) or None,
        }
    )


def _track(t: Track, index: int, req: AICommandRequest, assets: dict[str, str]) -> dict[str, Any]:
    selected = set(req.selection.clip_ids) | set(req.selection.effect_ids)
    items = t.items
    omitted = 0
    if len(items) > MAX_TRACK_ITEMS:
        keep = [
            i
            for i in items
            if i.id in selected
            or (i.start - NEAR_PLAYHEAD_SEC <= req.playhead <= item_end(i) + NEAR_PLAYHEAD_SEC)
        ][:MAX_TRACK_ITEMS]
        omitted = len(items) - len(keep)
        items = keep
    listed = [_clip(i, assets) if isinstance(i, Clip) else _effect(i) for i in items]
    return compact(
        {
            "id": t.id,
            "index": index,
            "kind": t.kind,
            "name": t.name,
            "muted": t.muted,
            "hidden": t.hidden,
            "locked": t.locked,
            "items": listed,
            "omittedItems": omitted or None,
            "itemsSpan": [r3(t.items[0].start), r3(item_end(t.items[-1]))] if omitted else None,
        }
    )


def _selection_range(p: Project, req: AICommandRequest) -> tuple[float, float] | None:
    spans = [
        (item.start, item_end(item))
        for t in p.tracks
        for item in t.items
        if item.id in req.selection.clip_ids and isinstance(item, Clip) and t.kind != "audio"
    ]
    if not spans:
        return None
    return min(s for s, _ in spans), max(e for _, e in spans)


def _marker_row(tm: TimelineMarker) -> dict[str, Any]:
    return compact(
        {"id": tm.marker.id, "t": r3(tm.t), "kind": tm.marker.kind, "s": round(tm.marker.strength, 2)}
    )


def _music(p: Project, req: AICommandRequest) -> dict[str, Any] | None:
    music = resolve_music_clip(p, None)
    if music is None:
        return None
    markers = clip_markers_on_timeline(music)
    by_kind = Counter(tm.marker.kind for tm in markers)
    sections = [s for s in timeline_sections(p) if s.clip_id in (None, music.id)]
    per_section = [
        compact(
            {
                "label": s.label,
                "start": r3(s.start),
                "end": r3(s.end),
                "counts": dict(Counter(tm.marker.kind for tm in markers if s.start <= tm.t < s.end)),
            }
        )
        for s in sections
    ]
    rng = _selection_range(p, req)
    pool = [tm for tm in markers if rng is None or rng[0] - 1e-6 <= tm.t <= rng[1] + 1e-6]
    pool = [tm for tm in pool if tm.marker.kind != "onset"] or pool
    picked = sorted(pool, key=lambda tm: -tm.marker.strength)[:MAX_LISTED_MARKERS]
    selected = {m for m in req.selection.marker_ids}
    picked_ids = {tm.marker.id for tm in picked}
    picked += [tm for tm in markers if tm.marker.id in selected and tm.marker.id not in picked_ids]
    picked.sort(key=lambda tm: tm.t)
    bass = sorted(tm.marker.strength for tm in markers if tm.marker.kind == "bass")
    quantiles = (
        {
            q: round(bass[min(len(bass) - 1, int(len(bass) * f))], 2)
            for q, f in (("p50", 0.5), ("p75", 0.75), ("p90", 0.9))
        }
        if bass
        else None
    )
    return compact(
        {
            "clipId": music.id,
            "start": r3(music.start),
            "end": r3(item_end(music)),
            "markerCounts": dict(by_kind),
            "bassStrength": quantiles,
            "perSection": per_section,
            "listedMarkers": (
                f"в диапазоне выделенных клипов {r3(rng[0])}–{r3(rng[1])}"
                if rng
                else f"до {MAX_LISTED_MARKERS} сильнейших (кроме onset)"
            ),
            "markers": [_marker_row(tm) for tm in picked],
        }
    )


def registry_summary(registry: Registry) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in registry.effects.values():
        params = [
            compact(
                {
                    "key": p.key,
                    "type": p.type,
                    "default": p.default,
                    "min": p.min,
                    "max": p.max,
                    "options": p.options,
                }
            )
            for p in e.params
        ]
        out.append(
            {
                "id": e.id,
                "name": e.name,
                "category": e.category,
                "hint": e.ai_hint,
                "defaultDuration": e.default_duration,
                "params": params,
            }
        )
    return out


def summarize(req: AICommandRequest, registry: Registry, ramp_presets: list[RampPreset]) -> dict[str, Any]:
    p = req.project
    assets = {a.id: a.name for a in p.assets}
    used_assets = {i.asset_id for t in p.tracks for i in t.items if isinstance(i, Clip)}
    return compact(
        {
            "project": {
                "name": p.name,
                "fps": p.fps,
                "width": p.width,
                "height": p.height,
                "duration": r3(p.duration),
            },
            "playhead": r3(req.playhead),
            "selection": compact(
                {
                    "clipIds": req.selection.clip_ids,
                    "markerIds": req.selection.marker_ids,
                    "effectIds": req.selection.effect_ids,
                }
            ),
            "assets": [
                compact(
                    {
                        "id": a.id,
                        "kind": a.kind,
                        "name": a.name,
                        "duration": r3(a.duration),
                        "used": a.id in used_assets,
                    }
                )
                for a in p.assets
                if a.parent is None
            ],
            "tracks": [_track(t, i, req, assets) for i, t in enumerate(p.tracks)],
            "music": _music(p, req),
            "sections": [
                compact(
                    {
                        "id": s.id,
                        "owner": s.clip_id or "project",
                        "label": s.label,
                        "start": r3(s.start),
                        "end": r3(s.end),
                        "energy": round(s.energy, 2),
                    }
                )
                for s in timeline_sections(p)
            ],
            "projectMarkers": [
                _marker_row(TimelineMarker(m, None, m.t))
                for m in sorted(p.markers, key=lambda m: -m.strength)[:MAX_LISTED_MARKERS]
            ],
            "effects": registry_summary(registry),
            "rampPresets": [{"id": r.id, "name": r.name, "description": r.description} for r in ramp_presets],
        }
    )
