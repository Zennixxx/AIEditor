from __future__ import annotations

import importlib.util
import shutil

from fastapi import APIRouter, Request

from app.config import SCHEMA_VERSION, VERSION, Settings, ffmpeg_bin, ffprobe_bin, rife_bin
from app.effects.registry import Registry
from app.models.gen import DiskInfo, Health
from app.storage.paths import DataPaths

router = APIRouter(tags=["health"])


@router.get("/health", response_model=Health, response_model_by_alias=True, response_model_exclude_none=True)
async def health(request: Request) -> Health:
    s: Settings = request.app.state.settings
    registry: Registry = request.app.state.registry
    paths: DataPaths = request.app.state.paths
    usage = shutil.disk_usage(paths.root)
    return Health(
        status="ok",
        version=VERSION,
        schema_version=SCHEMA_VERSION,
        ffmpeg=ffmpeg_bin(s) is not None and ffprobe_bin(s) is not None,
        rife=rife_bin(s) is not None,
        demucs=importlib.util.find_spec("demucs") is not None,
        gemini=bool(s.gemini_api_key),
        gpus=request.app.state.gpus,
        disk=DiskInfo(path=str(paths.root), free=usage.free, total=usage.total),
        registry_errors=registry.errors or None,
    )
