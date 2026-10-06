from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.ai.autoedit import AutoEditService, load_styles
from app.ai.client import create_llm
from app.ai.clip import ClipAIService
from app.ai.command import CopilotService, load_ramp_presets
from app.ai.music import MusicAIService
from app.ai.style import StyleRefService
from app.audio.analysis import MusicAnalysisService
from app.config import VERSION, Settings, ffmpeg_bin, get_settings, rife_bin
from app.effects.registry import load_registry
from app.errors import install_error_handlers
from app.jobs.events import EventHub
from app.jobs.manager import RESOURCE_LIMITS, JobManager
from app.media.pipeline import MediaService
from app.routers import ai, analysis, assets, cache, debug, export, health, jobs, presets, projects, ws
from app.storage.assets_repo import AssetsRepo
from app.storage.cache_cleanup import CacheCleaner
from app.storage.paths import DataPaths
from app.storage.presets_repo import PresetsRepo
from app.storage.projects_repo import ProjectsRepo
from app.video.analysis import ClipAnalysisService
from app.video.gpu import probe_rife_gpus
from app.video.interpolate import InterpolationService

log = logging.getLogger("app")


def _setup_logging(paths: DataPaths) -> None:
    root = logging.getLogger()
    if any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        return
    handler = RotatingFileHandler(
        paths.logs / "backend.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.INFO)


async def _probe_gpus(app: FastAPI, settings: Settings) -> None:
    rife = rife_bin(settings)
    if rife is None or not settings.aieditor_probe_gpu:
        return
    app.state.gpus = await asyncio.to_thread(probe_rife_gpus, rife)
    log.info("RIFE Vulkan devices: %s", app.state.gpus)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    paths = DataPaths(settings.data_dir)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        paths.ensure()
        _setup_logging(paths)
        executor = ProcessPoolExecutor(max_workers=RESOURCE_LIMITS["cpu"])
        hub = EventHub()
        app.state.settings = settings
        app.state.paths = paths
        app.state.hub = hub
        app.state.jobs = JobManager(hub, executor)
        app.state.assets = AssetsRepo(paths)
        app.state.assets.load_all()
        app.state.projects = ProjectsRepo(paths)
        app.state.cache = CacheCleaner(paths, app.state.assets, app.state.projects, app.state.jobs)
        app.state.gpus = None
        app.state.registry = load_registry(settings.aieditor_shared_dir)
        app.state.presets = PresetsRepo(paths)
        app.state.llm = create_llm(settings, paths)
        app.state.copilot = CopilotService(
            app.state.registry, load_ramp_presets(settings.aieditor_shared_dir), app.state.assets.get
        )
        app.state.analysis = MusicAnalysisService(settings, paths, app.state.assets, app.state.jobs)
        app.state.clip_analysis = ClipAnalysisService(settings, paths, app.state.assets, app.state.jobs)
        app.state.clip_ai = ClipAIService(paths, app.state.assets, app.state.jobs, app.state.clip_analysis)
        app.state.music_ai = MusicAIService(paths, app.state.jobs, app.state.analysis)
        app.state.auto_edit = AutoEditService(
            app.state.registry,
            load_styles(settings.aieditor_shared_dir),
            load_ramp_presets(settings.aieditor_shared_dir),
            app.state.assets,
            app.state.jobs,
            app.state.clip_analysis,
            app.state.clip_ai,
        )
        app.state.style_ref = StyleRefService(
            paths,
            app.state.assets,
            app.state.jobs,
            app.state.clip_analysis,
            app.state.analysis,
            app.state.presets,
            app.state.registry,
            load_ramp_presets(settings.aieditor_shared_dir),
        )
        app.state.interpolation = InterpolationService(settings, paths, app.state.assets, app.state.jobs, hub)
        app.state.media = MediaService(
            settings, paths, app.state.assets, app.state.jobs, hub, app.state.clip_analysis
        )
        log.info(
            "AIEditor backend %s, data=%s, ffmpeg=%s, rife=%s",
            VERSION,
            paths.root,
            ffmpeg_bin(settings),
            rife_bin(settings),
        )
        await app.state.media.resume()
        gpu_probe = asyncio.create_task(_probe_gpus(app, settings))
        try:
            yield
        finally:
            gpu_probe.cancel()
            with contextlib.suppress(BaseException):
                await gpu_probe
            await app.state.media.shutdown()
            await app.state.jobs.shutdown()
            executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="AIEditor backend", version=VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.aieditor_cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length", "Content-Disposition"],
    )
    install_error_handlers(app)

    api = APIRouter(prefix="/api")
    api.include_router(health.router)
    api.include_router(jobs.router)
    api.include_router(assets.router)
    api.include_router(analysis.router)
    api.include_router(projects.router)
    api.include_router(presets.router)
    api.include_router(export.router)
    api.include_router(cache.router)
    api.include_router(ai.router)
    api.include_router(ws.router)
    if settings.aieditor_debug:
        api.include_router(debug.router)
    app.include_router(api)
    return app


app = create_app()
