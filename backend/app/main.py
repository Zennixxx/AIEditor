from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import VERSION, Settings, ffmpeg_bin, get_settings, rife_bin
from app.errors import install_error_handlers
from app.jobs.events import EventHub
from app.jobs.manager import RESOURCE_LIMITS, JobManager
from app.routers import debug, health, jobs, ws
from app.storage.paths import DataPaths

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
        log.info(
            "AIEditor backend %s, data=%s, ffmpeg=%s, rife=%s",
            VERSION,
            paths.root,
            ffmpeg_bin(settings),
            rife_bin(settings),
        )
        try:
            yield
        finally:
            await app.state.jobs.shutdown()
            executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="AIEditor backend", version=VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.aieditor_cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    )
    install_error_handlers(app)

    api = APIRouter(prefix="/api")
    api.include_router(health.router)
    api.include_router(jobs.router)
    api.include_router(ws.router)
    if settings.aieditor_debug:
        api.include_router(debug.router)
    app.include_router(api)
    return app


app = create_app()
