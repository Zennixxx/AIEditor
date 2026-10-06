"""Пресеты-комбо эффектов — CONTRACT §8."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.effects.registry import Registry
from app.errors import ApiException
from app.models.gen import CreateEffectPresetRequest, EffectPreset, StylePreset
from app.storage.presets_repo import PresetsRepo

router = APIRouter(prefix="/presets", tags=["presets"])


def _repo(request: Request) -> PresetsRepo:
    return request.app.state.presets


@router.get("", response_model=list[EffectPreset], response_model_exclude_none=True)
async def list_presets(request: Request) -> list[EffectPreset]:
    return _repo(request).list()


@router.get("/styles", response_model=list[StylePreset], response_model_exclude_none=True)
async def list_styles(request: Request) -> list[StylePreset]:
    return _repo(request).list_styles()


@router.post("", response_model=EffectPreset, response_model_exclude_none=True)
async def create_preset(body: CreateEffectPresetRequest, request: Request) -> EffectPreset:
    registry: Registry = request.app.state.registry
    errors = registry.preset_errors(body.effects)
    if errors:
        raise ApiException(
            422, "invalid_preset", "Пресет не соответствует реестру эффектов", {"errors": errors}
        )
    return _repo(request).create(body)
