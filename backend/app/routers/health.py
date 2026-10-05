from __future__ import annotations

import importlib.util

from fastapi import APIRouter

from app.config import SCHEMA_VERSION, VERSION, ffmpeg_bin, ffprobe_bin, get_settings, rife_bin
from app.models.gen import Health

router = APIRouter(tags=["health"])


@router.get("/health", response_model=Health, response_model_by_alias=True)
async def health() -> Health:
    s = get_settings()
    return Health(
        status="ok",
        version=VERSION,
        schema_version=SCHEMA_VERSION,
        ffmpeg=ffmpeg_bin(s) is not None and ffprobe_bin(s) is not None,
        rife=rife_bin(s) is not None,
        demucs=importlib.util.find_spec("demucs") is not None,
        gemini=bool(s.gemini_api_key),
    )
