"""Сухой прогон edit-ops на копии проекта — порт `frontend/src/model/ops/applyOps.ts` (CONTRACT §6).

Примитивные ops повторяют семантику фронта; макро-ops не раскрываются точно (это делает фронт),
а проверяются (реестр, фильтр, ссылки, перекрытия) и оставляют в копии структурно похожий результат,
чтобы последующие ops списка видели правдоподобное состояние.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field

from app.ai.timeline import (
    EPS,
    OpsError,
    TimelineMarker,
    dedupe_close,
    effective_source_out,
    filter_markers,
    find_clip,
    forward_source,
    item_end,
    iter_clips,
)
from app.effects.registry import Registry
from app.ids import new_id
from app.models.gen import (
    Asset,
    Clip,
    ClipInput,
    ClipRef,
    EffectAnchor,
    EffectInput,
    EffectItem,
    Envelope,
    Marker,
    MarkerInput,
    OpAddClip,
    OpAddEffect,
    OpAddMarkers,
    OpAddTrack,
    OpApplyEffectToMarkers,
    OpCutToMarkers,
    OpMoveClip,
    OpMoveTrack,
    OpRemoveClip,
    OpRemoveEffect,
    OpRemoveMarkers,
    OpRemoveTrack,
    OpSetSections,
    OpSetTimeRemap,
    OpSnapClipEdgesToMarkers,
    OpSplitClip,
    OpUpdateClip,
    OpUpdateEffect,
    OpUpdateMarker,
    OpUpdateTrack,
    Project,
    RampKeyframe,
    Section,
    SectionInput,
    Track,
    TrackInput,
    TrackRef,
)
from app.models.ops import StrictEditOp

SECTION_LABELS = ("intro", "verse", "build", "drop", "break", "outro", "other")

type AssetResolver = Callable[[str], Asset | None]


def _no_asset(_: str) -> Asset | None:
    return None


@dataclass(slots=True)
class MarkerRef:
    marker: Marker
    owner: list[Marker]
    clip: Clip | None


@dataclass(slots=True)
class EffectRef:
    effect: EffectItem
    owner: list[EffectItem] | list[Clip | EffectItem]
    track: Track
    clip: Clip | None


@dataclass
class DryRun:
    project: Project
    registry: Registry
    resolve_asset: AssetResolver = _no_asset
    id_map: dict[str, str] = field(default_factory=dict)
    ids: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.ids = collect_ids(self.project)

    @property
    def p(self) -> Project:
        return self.project

    def ref(self, id_: str) -> str:
        if not id_.startswith("tmp_"):
            return id_
        real = self.id_map.get(id_)
        if real is None:
            raise OpsError("unknown_temp_id", f"Временный ID {id_} не был создан ранее в этом списке ops")
        return real

    def alloc(self, prefix: str, requested: str | None = None) -> str:
        if requested and not requested.startswith("tmp_"):
            if not requested.startswith(prefix + "_"):
                raise OpsError("bad_id", f"ID {requested} должен начинаться с {prefix}_")
            id_ = requested
        else:
            id_ = new_id(prefix)
            while id_ in self.ids:
                id_ = new_id(prefix)
        if id_ in self.ids:
            raise OpsError("duplicate_id", f"ID {id_} уже существует")
        if requested and requested.startswith("tmp_"):
            if requested in self.id_map:
                raise OpsError("duplicate_id", f"Временный ID {requested} уже использован")
            self.id_map[requested] = id_
        self.ids.add(id_)
        return id_

    def track(self, track_id: str) -> Track:
        real = self.ref(track_id)
        for t in self.p.tracks:
            if t.id == real:
                return t
        raise OpsError("track_not_found", f"Дорожка {track_id} не найдена")

    def clip(self, clip_id: str) -> tuple[Track, Clip, int]:
        ref = find_clip(self.p, self.ref(clip_id))
        if ref is None:
            raise OpsError("clip_not_found", f"Клип {clip_id} не найден")
        return ref

    def marker(self, marker_id: str) -> MarkerRef:
        real = self.ref(marker_id)
        for m in self.p.markers:
            if m.id == real:
                return MarkerRef(m, self.p.markers, None)
        for _, c in iter_clips(self.p):
            for m in c.markers:
                if m.id == real:
                    return MarkerRef(m, c.markers, c)
        raise OpsError("marker_not_found", f"Маркер {marker_id} не найден")

    def effect(self, effect_id: str) -> EffectRef:
        real = self.ref(effect_id)
        for t in self.p.tracks:
            for item in t.items:
                if isinstance(item, EffectItem) and item.id == real:
                    return EffectRef(item, t.items, t, None)
                if isinstance(item, Clip):
                    for e in item.effects:
                        if e.id == real:
                            return EffectRef(e, item.effects, t, item)
        raise OpsError("effect_not_found", f"Эффект {effect_id} не найден")

    def asset(self, asset_id: str) -> Asset:
        for a in self.p.assets:
            if a.id == asset_id:
                return a
        resolved = self.resolve_asset(asset_id)
        if resolved is None:
            raise OpsError("asset_not_found", f"Ассет {asset_id} не найден")
        copy = resolved.model_copy(deep=True)
        self.p.assets.append(copy)
        return copy

    def apply(self, op: StrictEditOp) -> None:
        match op:
            case OpAddTrack():
                self._add_track(op.track, op.index)
            case OpRemoveTrack():
                self.p.tracks.remove(self.track(op.track_id))
            case OpUpdateTrack():
                self._update_track(op)
            case OpMoveTrack():
                track = self.track(op.track_id)
                self.p.tracks.remove(track)
                self.p.tracks.insert(min(op.index, len(self.p.tracks)), track)
            case OpAddClip():
                self._add_clip(op.track_id, op.clip)
            case OpUpdateClip():
                self._update_clip(op)
            case OpMoveClip():
                self._move_clip(op)
            case OpSplitClip():
                self._split_clip(op.clip_id, op.at)
            case OpRemoveClip():
                self._remove_clip(op.clip_id, bool(op.ripple))
            case OpSetTimeRemap():
                self._set_time_remap(op)
            case OpAddMarkers():
                self._add_markers(op)
            case OpUpdateMarker():
                ref = self.marker(op.marker_id)
                for k, v in op.patch.model_dump(exclude_none=True).items():
                    setattr(ref.marker, k, v)
                _validate_marker(ref.marker)
                ref.owner.sort(key=lambda m: m.t)
            case OpRemoveMarkers():
                for mid in op.marker_ids:
                    ref = self.marker(mid)
                    ref.owner.remove(ref.marker)
                    self.ids.discard(ref.marker.id)
            case OpSetSections():
                self._set_sections(op)
            case OpAddEffect():
                self._add_effect(op)
            case OpUpdateEffect():
                self._update_effect(op)
            case OpRemoveEffect():
                ref = self.effect(op.effect_id)
                ref.owner.remove(ref.effect)  # type: ignore[arg-type]
                self.ids.discard(ref.effect.id)
            case OpApplyEffectToMarkers():
                self._apply_effect_to_markers(op)
            case OpCutToMarkers():
                self._cut_to_markers(op)
            case OpSnapClipEdgesToMarkers():
                self._snap_edges(op)

    def _add_track(self, inp: TrackInput, index: int | None) -> None:
        track = Track(
            id=self.alloc("trk", inp.id),
            kind=inp.kind,
            name=inp.name,
            muted=inp.muted,
            locked=inp.locked,
            hidden=inp.hidden,
            volume=inp.volume,
            items=[],
        )
        at = len(self.p.tracks) if index is None else max(0, min(index, len(self.p.tracks)))
        self.p.tracks.insert(at, track)

    def _update_track(self, op: OpUpdateTrack) -> None:
        track = self.track(op.track_id)
        patch = op.patch
        if patch.name is not None and not patch.name.strip():
            raise OpsError("bad_value", "Имя дорожки не может быть пустым")
        if patch.volume is not None and track.kind != "audio":
            raise OpsError("bad_value", "Громкость есть только у аудиодорожки")
        for k, v in patch.model_dump(exclude_none=True).items():
            setattr(track, k, v)

    def _add_clip(self, track_id: str, inp: ClipInput) -> None:
        track = self.track(track_id)
        asset = self.asset(inp.asset_id)
        _check_accepts(track, asset)
        data = inp.model_copy(deep=True)
        clip = Clip.model_validate(
            {**data.model_dump(exclude={"id", "markers", "sections", "effects"}), "id": "tmp_x"}
        )
        clip.id = self.alloc("clp", inp.id)
        clip.markers = [
            Marker.model_validate({**m.model_dump(exclude={"id"}), "id": self.alloc("mrk", m.id)})
            for m in data.markers
        ]
        if data.sections is not None:
            clip.sections = self._section_list(data.sections)
        clip.effects = [self._effect_item(e) for e in data.effects]
        track.items.append(clip)

    def _update_clip(self, op: OpUpdateClip) -> None:
        track, clip, _ = self.clip(op.clip_id)
        if op.patch.asset_id is not None:
            _check_accepts(track, self.asset(op.patch.asset_id))
        for k in op.patch.model_fields_set:
            v = getattr(op.patch, k)
            if v is not None:
                setattr(clip, k, v)

    def _move_clip(self, op: OpMoveClip) -> None:
        track, clip, index = self.clip(op.clip_id)
        clip.start = op.start
        if op.track_id is None:
            return
        target = self.track(op.track_id)
        if target is track:
            return
        if target.kind != track.kind:
            raise OpsError(
                "incompatible_track", f"Нельзя перенести клип с дорожки {track.kind} на {target.kind}"
            )
        track.items.pop(index)
        target.items.append(clip)

    def _split_clip(self, clip_id: str, at: float) -> None:
        track, clip, index = self.clip(clip_id)
        if not clip.start + EPS < at < item_end(clip) - EPS:
            raise OpsError("split_out_of_range", f"Точка разреза {at} вне клипа {clip.id}")
        tau = at - clip.start
        out = effective_source_out(clip)
        consumed = forward_source(clip, tau) - clip.source_in
        cut = out - consumed if clip.reverse else clip.source_in + consumed
        left_range = (cut, out) if clip.reverse else (clip.source_in, cut)
        right_range = (clip.source_in, cut) if clip.reverse else (cut, out)
        left = clip.model_copy(deep=True)
        right = clip.model_copy(deep=True)
        right.id = self.alloc("clp")
        left.duration, right.duration = tau, clip.duration - tau
        right.start = at
        left.source_in, left.source_out = left_range
        right.source_in, right.source_out = right_range
        if clip.time_remap is not None:
            left.time_remap = clip.time_remap.model_copy(update={"fit": "stretch"}, deep=True)
            right.time_remap = clip.time_remap.model_copy(update={"fit": "stretch"}, deep=True)

        def in_right(t: float) -> bool:
            return right_range[0] - EPS <= t <= right_range[1] + EPS

        right.markers = [m for m in clip.markers if in_right(m.t)]
        right_ids = {m.id for m in right.markers}
        left.markers = [m for m in clip.markers if m.id not in right_ids]
        left.effects = [e for e in left.effects if e.start < tau - EPS]
        right.effects = [e for e in right.effects if e.start >= tau - EPS]
        for e in right.effects:
            e.start -= tau
        if clip.sections is not None:

            def hits(s: Section, r: tuple[float, float]) -> bool:
                return s.start < r[1] - EPS and s.end > r[0] + EPS

            left.sections = [s for s in left.sections or [] if hits(s, left_range)]
            right.sections = [s for s in right.sections or [] if hits(s, right_range)]
            for s in right.sections:
                if hits(s, left_range):
                    s.id = self.alloc("sec")
        track.items[index : index + 1] = [left, right]
        for t in self.p.tracks:
            for item in t.items:
                for e in item.effects if isinstance(item, Clip) else [item]:
                    if e.anchor and e.anchor.clip_id == clip.id and e.anchor.marker_id in right_ids:
                        e.anchor.clip_id = right.id

    def _remove_clip(self, clip_id: str, ripple: bool) -> None:
        track, clip, index = self.clip(clip_id)
        track.items.pop(index)
        self.ids.discard(clip.id)
        if ripple:
            end = item_end(clip)
            for item in track.items:
                if item.start >= end - EPS:
                    item.start -= clip.duration

    def _set_time_remap(self, op: OpSetTimeRemap) -> None:
        _, clip, _ = self.clip(op.clip_id)
        remap = op.time_remap
        if remap is None:
            out = effective_source_out(clip)
            clip.time_remap = None
            clip.source_out = out
            clip.speed = (out - clip.source_in) / clip.duration
            return
        _validate_ramp_keys(remap.keyframes)
        clip.time_remap = remap.model_copy(deep=True)
        if remap.fit == "free":
            clip.source_out = effective_source_out(clip)

    def _add_markers(self, op: OpAddMarkers) -> None:
        owner = self.p.markers if op.target == "project" else self.clip(_clip_ref(op.target))[1].markers
        for inp in op.markers:
            m = _marker_from(inp, self.alloc("mrk", inp.id))
            _validate_marker(m)
            owner.append(m)
        owner.sort(key=lambda m: m.t)

    def _section_list(self, inp: Iterable[SectionInput | Section]) -> list[Section]:
        ordered = sorted(inp, key=lambda s: s.start)
        err = section_list_error(ordered)
        if err:
            raise OpsError("bad_value", err)
        return [
            Section.model_validate({**s.model_dump(exclude={"id"}), "id": self.alloc("sec", s.id)})
            for s in ordered
        ]

    def _set_sections(self, op: OpSetSections) -> None:
        if op.target == "project":
            for s in self.p.sections:
                self.ids.discard(s.id)
            self.p.sections = self._section_list(op.sections)
            return
        track, clip, _ = self.clip(_clip_ref(op.target))
        asset = next((a for a in self.p.assets if a.id == clip.asset_id), None)
        if track.kind != "audio" and not (track.kind == "video" and asset and asset.has_audio):
            raise OpsError(
                "bad_value", "Секции музыки можно задать только аудиоклипу или видеоклипу со звуком"
            )
        for s in clip.sections or []:
            self.ids.discard(s.id)
        clip.sections = self._section_list(op.sections)

    def _check_params(self, effect: str, params: dict[str, float | str | bool]) -> None:
        if effect not in self.registry.effects:
            raise OpsError("unknown_effect", f"Неизвестный эффект {effect}")
        errors = self.registry.param_errors(effect, params, "params")
        if errors:
            raise OpsError("bad_value", "; ".join(errors))

    def _effect_item(self, inp: EffectInput | EffectItem) -> EffectItem:
        self._check_params(inp.effect, inp.params)
        anchor = self._anchor(inp.anchor) if inp.anchor else None
        return EffectItem(
            id=self.alloc("fx", inp.id),
            effect=inp.effect,
            start=inp.start,
            duration=inp.duration,
            params=dict(inp.params),
            envelope=inp.envelope.model_copy(),
            anchor=anchor,
            enabled=inp.enabled,
        )

    def _anchor(self, a: EffectAnchor) -> EffectAnchor:
        marker_id = self.ref(a.marker_id)
        self.marker(marker_id)
        clip_id = None
        if a.clip_id is not None:
            clip_id = self.ref(a.clip_id)
            self.clip(clip_id)
        return EffectAnchor(marker_id=marker_id, clip_id=clip_id, offset=a.offset)

    def _add_effect(self, op: OpAddEffect) -> None:
        effect = self._effect_item(op.effect)
        if isinstance(op.target, TrackRef):
            track = self.track(op.target.track_id)
            if track.kind != "fx":
                raise OpsError("incompatible_track", "Эффект можно положить только на fx-дорожку")
            track.items.append(effect)
        else:
            self.clip(op.target.clip_id)[1].effects.append(effect)

    def _update_effect(self, op: OpUpdateEffect) -> None:
        ref = self.effect(op.effect_id)
        patch = op.patch
        effect_id = patch.effect if patch.effect is not None else ref.effect.effect
        params = patch.params if patch.params is not None else ref.effect.params
        self._check_params(effect_id, params)
        for k in patch.model_fields_set:
            v = getattr(patch, k)
            if v is None:
                continue
            setattr(ref.effect, k, self._anchor(v) if k == "anchor" else v)

    def _filtered(self, op: OpApplyEffectToMarkers | OpCutToMarkers) -> list[TimelineMarker]:
        return dedupe_close(filter_markers(self.p, op.filter), self.p.fps)

    def _apply_effect_to_markers(self, op: OpApplyEffectToMarkers) -> None:
        definition = self.registry.effects.get(op.effect)
        if definition is None:
            raise OpsError("unknown_effect", f"Неизвестный эффект {op.effect}")
        params = dict(op.params or {})
        self._check_params(op.effect, params)
        duration = op.duration if op.duration is not None else definition.default_duration
        envelope = Envelope.model_validate(
            {
                **definition.default_envelope.model_dump(),
                **(op.envelope.model_dump(exclude_none=True) if op.envelope else {}),
            }
        )
        markers = self._filtered(op)
        if not markers:
            raise OpsError("no_markers", "Фильтр не оставил ни одного маркера")

        def dur_at(i: int) -> float:
            return min(duration, markers[i + 1].t - markers[i].t) if i + 1 < len(markers) else duration

        def item(start: float, d: float) -> EffectItem:
            return EffectItem(
                id=self.alloc("fx"), effect=op.effect, start=start, duration=d, params=params,
                envelope=envelope.model_copy(), enabled=True,
            )  # fmt: skip

        if op.target == "clipsUnderMarker":
            added = 0
            for i, tm in enumerate(markers):
                for track, clip in iter_clips(self.p):
                    if track.kind != "video" or not clip.start - EPS <= tm.t < item_end(clip) - EPS:
                        continue
                    start = max(0.0, tm.t - clip.start)
                    d = min(dur_at(i), clip.duration - start)
                    if d > EPS:
                        clip.effects.append(item(start, d))
                        added += 1
            if not added:
                raise OpsError("no_markers", "Под отфильтрованными маркерами нет видеоклипов")
            return
        if op.target == "newFxTrack":
            track = Track(
                id=self.alloc("trk"), kind="fx", name=f"FX: {definition.name}",
                muted=False, locked=False, hidden=False, volume=None, items=[],
            )  # fmt: skip
            self.p.tracks.append(track)
        else:
            assert isinstance(op.target, TrackRef)
            track = self.track(op.target.track_id)
            if track.kind != "fx":
                raise OpsError("incompatible_track", "Эффекты по маркерам кладутся на fx-дорожку")
            for i, tm in enumerate(markers):
                end = tm.t + dur_at(i)
                if any(it.start < end - EPS and item_end(it) > tm.t + EPS for it in track.items):
                    raise OpsError("slots_overlap", f"На дорожке {track.name} уже есть эффект в {tm.t:.3f} с")
        for i, tm in enumerate(markers):
            track.items.append(item(tm.t, dur_at(i)))

    def _cut_to_markers(self, op: OpCutToMarkers) -> None:
        markers = self._filtered(op)
        if len(markers) < 2:
            raise OpsError("no_slots", "Для нарезки нужно минимум два маркера")
        sources: list[tuple[Track, Clip]] = []
        for cid in op.clip_ids:
            track, clip, _ = self.clip(cid)
            if track.kind != "video":
                raise OpsError("incompatible_track", f"Клип {cid} не на видеодорожке")
            sources.append((track, clip))
        sources.sort(key=lambda tc: tc[1].start)
        target = self.track(op.track_id) if op.track_id else sources[0][0]
        if target.kind != "video":
            raise OpsError("incompatible_track", "Нарезка кладётся только на видеодорожку")
        for track, clip in sources:
            track.items.remove(clip)
            self.ids.discard(clip.id)
        for i in range(len(markers) - 1):
            a, b = markers[i].t, markers[i + 1].t
            if any(it.start < b - EPS and item_end(it) > a + EPS for it in target.items):
                raise OpsError("slots_overlap", f"Слот {a:.3f}–{b:.3f} перекрывает элементы дорожки")
            src = sources[i % len(sources)][1]
            target.items.append(self._slot_clip(src, a, b - a))

    def _slot_clip(self, src: Clip, start: float, d: float) -> Clip:
        asset = self.asset(src.asset_id)
        if asset.kind == "image":
            source_in, source_out = 0.0, d
        else:
            source_in = src.source_in
            source_out = min(effective_source_out(src), source_in + d)
        return Clip(
            id=self.alloc("clp"), asset_id=src.asset_id, start=start, duration=d,
            source_in=source_in, source_out=source_out, speed=(source_out - source_in) / d,
            reverse=False, transform=src.transform.model_copy(deep=True), opacity=1,
            blend_mode=src.blend_mode, effects=[], markers=[], color=src.color,
            time_remap=None, sections=None, interpolated_asset_id=None,
        )  # fmt: skip

    def _snap_edges(self, op: OpSnapClipEdgesToMarkers) -> None:
        for cid in op.clip_ids:
            self.clip(cid)
        filter_markers(self.p, op.filter)

    def finalize(self) -> list[str]:
        finalize_project(self.p)
        return check_invariants(self.p)


def _clip_ref(target: ClipRef | str) -> str:
    assert isinstance(target, ClipRef)
    return target.clip_id


def _check_accepts(track: Track, asset: Asset) -> None:
    ok = track.kind != "fx" and ((asset.kind == "audio") == (track.kind == "audio"))
    if not ok:
        raise OpsError("incompatible_track", f"Ассет {asset.kind} нельзя положить на дорожку {track.kind}")


def _marker_from(inp: MarkerInput, id_: str) -> Marker:
    return Marker.model_validate({**inp.model_dump(exclude={"id"}), "id": id_})


def _validate_marker(m: Marker) -> None:
    if m.t < 0:
        raise OpsError("bad_value", f"Маркер {m.id}: t < 0")
    if not 0 <= m.strength <= 1:
        raise OpsError("bad_value", f"Маркер {m.id}: strength вне 0..1")


def _validate_ramp_keys(keys: list[RampKeyframe]) -> None:
    if len(keys) < 2:
        raise OpsError("bad_time_remap", "Нужно минимум 2 ключа")
    if keys[0].u != 0 or keys[-1].u != 1:
        raise OpsError("bad_time_remap", "Первый ключ u=0, последний u=1")
    for a, b in itertools.pairwise(keys):
        if not b.u > a.u:
            raise OpsError("bad_time_remap", "u ключей должны возрастать")


def section_list_error(items: Sequence[SectionInput | Section]) -> str | None:
    for i, s in enumerate(items):
        if s.label not in SECTION_LABELS:
            return f"секция {i}: неизвестная метка {s.label}"
        if not s.start < s.end:
            return f"секция {i}: start должен быть меньше end"
        if i and s.start < items[i - 1].end - EPS:
            return f"секции {i - 1} и {i} перекрываются или не отсортированы"
    return None


def collect_ids(p: Project) -> set[str]:
    ids = {m.id for m in p.markers} | {s.id for s in p.sections}
    for t in p.tracks:
        ids.add(t.id)
        for item in t.items:
            ids.add(item.id)
            if isinstance(item, Clip):
                ids.update(e.id for e in item.effects)
                ids.update(m.id for m in item.markers)
                ids.update(s.id for s in item.sections or [])
    return ids


def finalize_project(p: Project) -> None:
    marker_ids = {m.id for m in p.markers}
    clip_ids: set[str] = set()
    end = 0.0
    for t in p.tracks:
        t.items.sort(key=lambda i: i.start)
        for item in t.items:
            end = max(end, item_end(item))
            if isinstance(item, Clip):
                clip_ids.add(item.id)
                marker_ids.update(m.id for m in item.markers)
    for t in p.tracks:
        for item in t.items:
            for e in item.effects if isinstance(item, Clip) else [item]:
                a = e.anchor
                if a and (a.marker_id not in marker_ids or (a.clip_id and a.clip_id not in clip_ids)):
                    e.anchor = None
    p.duration = end


def check_invariants(p: Project) -> list[str]:
    out: list[str] = []
    assets = {a.id: a for a in p.assets}
    seen: set[str] = set()

    def unique(id_: str) -> None:
        if id_ in seen:
            out.append(f"ID {id_} встречается дважды")
        seen.add(id_)

    for m in p.markers:
        unique(m.id)
    for s in p.sections:
        unique(s.id)
    if err := section_list_error(p.sections):
        out.append(f"project.sections: {err}")
    for track in p.tracks:
        unique(track.id)
        prev_end = -float("inf")
        for item in track.items:
            unique(item.id)
            if item.start < prev_end - EPS:
                out.append(f"Дорожка {track.name}: {item.id} перекрывает предыдущий элемент")
            prev_end = max(prev_end, item_end(item))
            if item.start < -EPS:
                out.append(f"{item.id}: start < 0")
            if (track.kind == "fx") != isinstance(item, EffectItem):
                out.append(f"Дорожка {track.kind} {track.id} не может содержать {item.type} {item.id}")
            if not isinstance(item, Clip):
                continue
            for e in item.effects:
                unique(e.id)
            for m in item.markers:
                unique(m.id)
            for s in item.sections or []:
                unique(s.id)
            if item.sections and (err := section_list_error(item.sections)):
                out.append(f"{item.id}.sections: {err}")
            asset = assets.get(item.asset_id)
            if asset is None:
                out.append(f"{item.id}: ассет {item.asset_id} отсутствует в project.assets")
                continue
            if (track.kind == "audio") != (asset.kind == "audio"):
                out.append(f"{item.id}: ассет {asset.kind} на дорожке {track.kind}")
            src_out = effective_source_out(item)
            if item.source_in < -EPS or not item.source_in < src_out:
                out.append(f"{item.id}: нарушено 0 ≤ sourceIn < sourceOut")
            if asset.kind != "image" and src_out > asset.duration + EPS:
                out.append(f"{item.id}: sourceOut {src_out:.3f} > длительности ассета {asset.duration:.3f}")
            if item.time_remap is None:
                expected = (item.source_out - item.source_in) / item.speed
                if abs(expected - item.duration) > 1e-6:
                    out.append(
                        f"{item.id}: duration {item.duration:.4f} ≠ (sourceOut − sourceIn) / speed "
                        f"= {expected:.4f}"
                    )
    return out
