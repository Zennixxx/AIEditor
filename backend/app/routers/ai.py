"""ИИ-эндпоинты — CONTRACT §8."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.ai.autoedit import AutoEditService
from app.ai.client import LLM, LLMError
from app.ai.clip import ClipAIService
from app.ai.command import CopilotService
from app.ai.music import MusicAIService
from app.ai.style import StyleRefService
from app.errors import ApiException
from app.ids import ASSET_ID_RE
from app.models.gen import AICommandRequest, AnalyzeClipRequest, Asset, AutoEditRequest, JobRef, OpsResult
from app.storage.assets_repo import AssetsRepo

router = APIRouter(prefix="/ai", tags=["ai"])


def _llm(request: Request) -> LLM:
    llm: LLM | None = request.app.state.llm
    if llm is None:
        raise ApiException(503, "gemini_not_configured", "Ключ Gemini не задан (GEMINI_API_KEY)")
    return llm


def _asset(request: Request, asset_id: str) -> Asset:
    repo: AssetsRepo = request.app.state.assets
    asset = repo.get(asset_id) if ASSET_ID_RE.match(asset_id) else None
    if asset is None:
        raise ApiException(404, "asset_not_found", f"Ассет {asset_id} не найден")
    return asset


@router.post("/analyze-clip/{asset_id}", response_model=JobRef, response_model_exclude_none=True)
async def analyze_clip(asset_id: str, request: Request, body: AnalyzeClipRequest | None = None) -> JobRef:
    asset = _asset(request, asset_id)
    service: ClipAIService = request.app.state.clip_ai
    return service.start(_llm(request), asset, bool(body and body.force))


@router.post("/analyze-music/{asset_id}", response_model=JobRef, response_model_exclude_none=True)
async def analyze_music(asset_id: str, request: Request) -> JobRef:
    asset = _asset(request, asset_id)
    service: MusicAIService = request.app.state.music_ai
    return service.start(_llm(request), asset)


@router.post("/command", response_model=OpsResult)
async def command(body: AICommandRequest, request: Request) -> JSONResponse:
    llm = _llm(request)
    service: CopilotService = request.app.state.copilot
    try:
        result = await service.run(llm, body)
    except LLMError as exc:
        raise ApiException(502, "gemini_failed", exc.message, {"reason": exc.code}) from exc
    return JSONResponse(result.to_json())


@router.post("/auto-edit", response_model=JobRef, response_model_exclude_none=True)
async def auto_edit(body: AutoEditRequest, request: Request) -> JobRef:
    service: AutoEditService = request.app.state.auto_edit
    return service.start(request.app.state.llm, body)


@router.post("/style-from-reference/{asset_id}", response_model=JobRef, response_model_exclude_none=True)
async def style_from_reference(asset_id: str, request: Request) -> JobRef:
    asset = _asset(request, asset_id)
    service: StyleRefService = request.app.state.style_ref
    return service.start(request.app.state.llm, asset)
