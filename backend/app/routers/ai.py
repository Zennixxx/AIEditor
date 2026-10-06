"""ИИ-эндпоинты — CONTRACT §8."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.ai.client import LLM, LLMError
from app.ai.command import CopilotService
from app.errors import ApiException
from app.models.gen import AICommandRequest, OpsResult

router = APIRouter(prefix="/ai", tags=["ai"])


def _llm(request: Request) -> LLM:
    llm: LLM | None = request.app.state.llm
    if llm is None:
        raise ApiException(503, "gemini_not_configured", "Ключ Gemini не задан (GEMINI_API_KEY)")
    return llm


@router.post("/command", response_model=OpsResult)
async def command(body: AICommandRequest, request: Request) -> JSONResponse:
    llm = _llm(request)
    service: CopilotService = request.app.state.copilot
    try:
        result = await service.run(llm, body)
    except LLMError as exc:
        raise ApiException(502, "gemini_failed", exc.message, {"reason": exc.code}) from exc
    return JSONResponse(result.to_json())
