"""Локальный анализ клипа (без Gemini): движение + склейки → `analysis/clip.json` — CONTRACT §4, §8.

Задача `clipAnalysis` ставится сразу после proxy при импорте видео. Gemini-часть (фаза 7) дополняет
этот же файл: `model`, `summary`, `moments`, типы шотов.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError

from app.config import Settings, ffmpeg_bin
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.models.gen import Asset, ClipAnalysis, Curve, Shot
from app.storage import atomic
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths
from app.video.frames import FPS, read_gray_frames
from app.video.motion import motion_curve
from app.video.scenes import detect_cuts, shots_from_cuts

log = logging.getLogger(__name__)


def build_local_analysis(
    asset_id: str, cuts: list[int], motion: list[float], duration: float
) -> ClipAnalysis:
    shots = [
        Shot(start=round(a, 3), end=round(b, 3), type="other")
        for a, b in shots_from_cuts(cuts, FPS, duration)
    ]
    return ClipAnalysis(
        asset_id=asset_id,
        model="",
        summary="",
        moments=[],
        shots=shots,
        motion=Curve(interval=1 / FPS, values=motion),
    )


class ClipAnalysisService:
    def __init__(self, settings: Settings, paths: DataPaths, repo: AssetsRepo, jobs: JobManager) -> None:
        self.settings = settings
        self.paths = paths
        self.repo = repo
        self.jobs = jobs
        self._inflight: dict[str, str] = {}

    def _file(self, asset_id: str) -> Path:
        return self.paths.analysis_dir(asset_id) / "clip.json"

    def get(self, asset_id: str) -> ClipAnalysis | None:
        f = self._file(asset_id)
        if not f.is_file():
            return None
        try:
            return ClipAnalysis.model_validate(atomic.read_json(f))
        except (OSError, ValueError, ValidationError):
            log.warning("broken clip analysis %s ignored", f)
            return None

    def write(self, analysis: ClipAnalysis) -> None:
        atomic.write_json(
            self._file(analysis.asset_id), analysis.model_dump(by_alias=True, exclude_none=True)
        )

    def wanted(self, asset: Asset) -> bool:
        return asset.kind == "video" and asset.parent is None and self.get(asset.id) is None

    def start(self, asset: Asset, depends_on: Sequence[str] = ()) -> str | None:
        """Поставить локальный анализ; None — не нужен (не видео, нет ffmpeg) или уже готов."""
        if asset.kind != "video" or asset.parent is not None or ffmpeg_bin(self.settings) is None:
            return None
        running = self._inflight.get(asset.id)
        if running is not None and (job := self.jobs.get(running)) and job.status in ("queued", "running"):
            return running
        if self.get(asset.id) is not None:
            return None

        async def run(ctx: JobContext) -> ClipAnalysis:
            return await self._run(ctx, asset.id)

        job = self.jobs.submit(
            "clipAnalysis",
            run,
            asset_id=asset.id,
            resource="ffmpeg",
            message="Анализ движения и склеек",
            depends_on=depends_on,
        )
        self._inflight[asset.id] = job.id
        return job.id

    def _source(self, asset: Asset) -> Path:
        proxy = self.paths.asset_dir(asset.id) / "proxy.mp4"
        if proxy.is_file():
            return proxy
        src = Path(asset.path)
        if not src.is_file():
            raise JobFailed("source_missing", f"Исходный файл недоступен: {src}")
        return src

    async def _run(self, ctx: JobContext, asset_id: str) -> ClipAnalysis:
        cached = self.get(asset_id)
        if cached is not None:
            ctx.progress(1.0, "Из кэша")
            return cached
        asset = self.repo.get(asset_id)
        ffmpeg = ffmpeg_bin(self.settings)
        if asset is None:
            raise JobFailed("asset_not_found", f"Ассет {asset_id} удалён")
        if ffmpeg is None:
            raise JobFailed("ffmpeg_missing", "ffmpeg не найден")
        frames = await read_gray_frames(
            ffmpeg, self._source(asset), asset.duration, lambda p: ctx.progress(p * 0.9)
        )
        if frames.shape[0] == 0:
            raise JobFailed("no_frames", "В видео не нашлось кадров")

        def compute() -> ClipAnalysis:
            cuts = detect_cuts(frames, FPS)
            return build_local_analysis(asset_id, cuts, motion_curve(frames, cuts), asset.duration)

        analysis = await asyncio.to_thread(compute)
        self.write(analysis)
        return analysis
