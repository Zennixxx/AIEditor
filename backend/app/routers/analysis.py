"""Анализ музыки — CONTRACT §4, §8."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.audio.analysis import MusicAnalysisService
from app.errors import ApiException
from app.ids import ASSET_ID_RE
from app.models.gen import Asset, JobRef, MusicAnalysis, MusicAnalysisParamsInput
from app.storage.assets_repo import AssetsRepo

router = APIRouter(prefix="/analysis", tags=["analysis"])


def _asset(request: Request, asset_id: str) -> Asset:
    repo: AssetsRepo = request.app.state.assets
    asset = repo.get(asset_id) if ASSET_ID_RE.match(asset_id) else None
    if asset is None:
        raise ApiException(404, "asset_not_found", f"Ассет {asset_id} не найден")
    return asset


@router.post("/music/{asset_id}", response_model=JobRef, response_model_exclude_none=True)
async def start_music_analysis(
    asset_id: str, request: Request, body: MusicAnalysisParamsInput | None = None
) -> JobRef:
    service: MusicAnalysisService = request.app.state.analysis
    return service.start(_asset(request, asset_id), body)


@router.get("/music/{asset_id}", response_model=MusicAnalysis, response_model_exclude_none=True)
async def get_music_analysis(asset_id: str, request: Request) -> MusicAnalysis:
    _asset(request, asset_id)
    service: MusicAnalysisService = request.app.state.analysis
    analysis = service.get(asset_id)
    if analysis is None:
        raise ApiException(404, "analysis_not_found", f"Анализ музыки для {asset_id} ещё не выполнен")
    return analysis
