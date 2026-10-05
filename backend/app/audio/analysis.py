"""Анализ музыки: параметры, кэш `analysis/music.json`, задача `musicAnalysis` — CONTRACT §4, §8."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.audio import stems as stems_mod
from app.audio.dsp import AudioDecodeError, analyze_file
from app.config import Settings, ffmpeg_bin
from app.errors import ApiException
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.models.gen import Asset, JobRef, MusicAnalysis, MusicAnalysisParams, MusicAnalysisParamsInput
from app.storage import atomic
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)

ALGO_VERSION = 1  # поднимать при смене алгоритма: инвалидирует кэш
DEFAULT_PARAMS = MusicAnalysisParams(bass_cutoff_hz=150, sensitivity=0.5, min_gap_sec=0.12, use_stems=False)


def merge_params(partial: MusicAnalysisParamsInput | None) -> MusicAnalysisParams:
    base = DEFAULT_PARAMS.model_dump()
    if partial is not None:
        base.update(partial.model_dump(exclude_none=True))
    return MusicAnalysisParams.model_validate(base)


def params_hash(params: MusicAnalysisParams) -> str:
    blob = json.dumps({"v": ALGO_VERSION, "params": params.model_dump(by_alias=True)}, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def stem_urls(asset_id: str) -> dict[str, str]:
    return {n: f"/api/assets/{asset_id}/stems/{n}.wav" for n in stems_mod.STEM_NAMES}


class MusicAnalysisService:
    def __init__(self, settings: Settings, paths: DataPaths, repo: AssetsRepo, jobs: JobManager) -> None:
        self.settings = settings
        self.paths = paths
        self.repo = repo
        self.jobs = jobs
        self._inflight: dict[tuple[str, str], str] = {}

    # ---------- кэш ----------

    def _cache_file(self, asset_id: str) -> Path:
        return self.paths.analysis_dir(asset_id) / "music.json"

    def _read_cache(self, asset_id: str) -> tuple[str, MusicAnalysis] | None:
        f = self._cache_file(asset_id)
        if not f.is_file():
            return None
        try:
            data = atomic.read_json(f)
            return str(data["paramsHash"]), MusicAnalysis.model_validate(data["analysis"])
        except (OSError, ValueError, KeyError, ValidationError):
            log.warning("broken analysis cache %s ignored", f)
            return None

    def get(self, asset_id: str) -> MusicAnalysis | None:
        cached = self._read_cache(asset_id)
        return cached[1] if cached else None

    def _write_cache(self, analysis: MusicAnalysis, phash: str) -> None:
        payload = {"paramsHash": phash, "analysis": analysis.model_dump(by_alias=True, exclude_none=True)}
        atomic.write_json(self._cache_file(analysis.asset_id), payload)

    # ---------- запуск ----------

    def _source(self, asset: Asset) -> Path:
        audio = self.paths.asset_dir(asset.id) / "audio.m4a"
        if audio.is_file():
            return audio
        src = Path(asset.path)
        if not src.is_file():
            raise JobFailed("source_missing", f"Исходный файл недоступен: {src}")
        return src

    def start(self, asset: Asset, partial: MusicAnalysisParamsInput | None) -> JobRef:
        if asset.kind == "image" or (asset.kind == "video" and not asset.has_audio):
            raise ApiException(422, "no_audio", f"В ассете {asset.id} нет звука для анализа")
        ffmpeg = ffmpeg_bin(self.settings)
        if ffmpeg is None:
            raise ApiException(503, "ffmpeg_missing", "ffmpeg/ffprobe не найдены (tools/bin или FFMPEG_PATH)")
        params = merge_params(partial)
        if params.use_stems:
            stems_mod.require_demucs()
        phash = params_hash(params)
        key = (asset.id, phash)
        running = self._inflight.get(key)
        if running is not None and (job := self.jobs.get(running)) and job.status in ("queued", "running"):
            return JobRef(job_id=running)

        async def run(ctx: JobContext) -> MusicAnalysis:
            return await self._run(ctx, asset.id, params, phash, ffmpeg)

        job = self.jobs.submit(
            "musicAnalysis", run, asset_id=asset.id, resource="cpu", message="Анализ музыки"
        )
        self._inflight[key] = job.id
        return JobRef(job_id=job.id)

    async def _run(
        self, ctx: JobContext, asset_id: str, params: MusicAnalysisParams, phash: str, ffmpeg: Path
    ) -> MusicAnalysis:
        cached = self._read_cache(asset_id)
        if cached is not None and cached[0] == phash:
            ctx.progress(1.0, "Из кэша")
            return cached[1]
        asset = self.repo.get(asset_id)
        if asset is None:
            raise JobFailed("asset_not_found", f"Ассет {asset_id} удалён")
        src = self._source(asset)

        rhythm: str | None = None
        stems: dict[str, str] | None = None
        if params.use_stems:
            stems_dir = self.paths.stems_dir(asset_id)
            await stems_mod.separate(ctx, ffmpeg, src, stems_dir)
            mix = self.paths.analysis_dir(asset_id) / "rhythm.wav"
            mix.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(stems_mod.mix_rhythm_stems, ffmpeg, stems_dir, mix)
            rhythm = str(mix)
            urls = stem_urls(asset_id)
            stems = {"drums": urls["drums"], "bass": urls["bass"]}

        ctx.progress(0.3, "Анализ: онсеты, доли, секции")
        raw_params = params.model_dump(by_alias=True)
        try:
            raw: dict[str, Any] = await ctx.run_cpu(analyze_file, str(ffmpeg), str(src), raw_params, rhythm)
        except AudioDecodeError as exc:
            raise JobFailed("audio_decode_failed", f"Не удалось прочитать аудио: {exc}") from exc
        analysis = MusicAnalysis.model_validate(
            {"assetId": asset_id, "params": raw_params, **raw, **({"stems": stems} if stems else {})}
        )
        self._write_cache(analysis, phash)
        return analysis
