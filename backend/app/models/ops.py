"""Строгий discriminated union EditOp (CONTRACT §6) поверх сгенерированных моделей."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field, TypeAdapter

from app.models.gen import (
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
)

type StrictEditOp = Annotated[
    OpAddTrack
    | OpRemoveTrack
    | OpUpdateTrack
    | OpMoveTrack
    | OpAddClip
    | OpUpdateClip
    | OpMoveClip
    | OpSplitClip
    | OpRemoveClip
    | OpSetTimeRemap
    | OpAddMarkers
    | OpUpdateMarker
    | OpRemoveMarkers
    | OpSetSections
    | OpAddEffect
    | OpUpdateEffect
    | OpRemoveEffect
    | OpApplyEffectToMarkers
    | OpCutToMarkers
    | OpSnapClipEdgesToMarkers,
    Field(discriminator="op"),
]

OP_NAMES: tuple[str, ...] = (
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
)

MACRO_OPS = frozenset({"applyEffectToMarkers", "cutToMarkers", "snapClipEdgesToMarkers"})

edit_op_adapter: TypeAdapter[StrictEditOp] = TypeAdapter(StrictEditOp)


def parse_op(raw: dict[str, Any]) -> StrictEditOp:
    return edit_op_adapter.validate_python(raw)


def dump_op(op: StrictEditOp) -> dict[str, Any]:
    out = op.model_dump(mode="json", by_alias=True, exclude_none=True)
    if isinstance(op, OpSetTimeRemap) and op.time_remap is None:
        out["timeRemap"] = None
    return out
