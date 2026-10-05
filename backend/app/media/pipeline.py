"""Импорт медиа и цепочка производных файлов — docs/BACKEND.md, фаза 1.

Видео: proxy → thumbs → audio → waveform (два последних — если есть звук) → mezzanine
(если нужно). Аудио: audio → waveform. Изображения: сразу `ready`, без задач.

Шаги — отдельные задачи `JobManager`, каждая ждёт предыдущую (`depends_on`) и не
падает из-за её ошибки: недостающий вход берётся из оригинала. Когда все шаги
завершились, сторож выставляет статус ассета (`ready`/`failed`) и шлёт WS `asset`.
Каждый новый производный файл тоже даёт событие `asset`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings, ffmpeg_bin, ffprobe_bin
from app.errors import ApiException
from app.ids import asset_id_for
from app.jobs.events import EventHub, dump
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.media.ffprobe import MediaInfo, UnsupportedMedia, build_asset, probe
from app.media.mezzanine import make_mezzanine
from app.media.proxy import make_audio, make_proxy
from app.media.thumbs import make_thumbs
from app.media.waveform import make_waveform
from app.models.gen import Asset, AssetDerived, JobKind, JobRef, WsAsset
from app.storage import atomic
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths
from app.video.analysis import ClipAnalysisService

log = logging.getLogger(__name__)

DERIVED_FILES = {
    "proxy": "proxy.mp4",
    "mezzanine": "mezzanine.mp4",
    "audio": "audio.m4a",
    "thumbs": "thumbs.json",
    "waveform": "waveform.json",
}


def asset_url(asset_id: str, name: str) -> str:
    return f"/api/assets/{asset_id}/{name}"


@dataclass(frozen=True, slots=True)
class Tools:
    ffmpeg: Path
    ffprobe: Path


type StepFn = Callable[[JobContext, Tools, MediaInfo, str], Awaitable[Any]]


class MediaService:
    def __init__(
        self,
        settings: Settings,
        paths: DataPaths,
        repo: AssetsRepo,
        jobs: JobManager,
        hub: EventHub,
        clip_analysis: ClipAnalysisService | None = None,
    ):
        self.clip_analysis = clip_analysis
        self.settings = settings
        self.paths = paths
        self.repo = repo
        self.jobs = jobs
        self.hub = hub
        self._active: dict[str, list[str]] = {}
        self._watchers: set[asyncio.Task[None]] = set()

    # ---------- инструменты ----------

    def tools(self) -> Tools:
        ffmpeg, ffprobe = ffmpeg_bin(self.settings), ffprobe_bin(self.settings)
        if ffmpeg is None or ffprobe is None:
            raise ApiException(503, "ffmpeg_missing", "ffmpeg/ffprobe не найдены (tools/bin или FFMPEG_PATH)")
        return Tools(ffmpeg, ffprobe)

    # ---------- импорт ----------

    async def import_paths(self, raw_paths: list[str]) -> tuple[list[Asset], list[JobRef]]:
        """Импорт по путям. Все пути проверяются до регистрации: ошибка → ничего не импортировано."""
        tools = self.tools()
        files: list[Path] = []
        missing: list[str] = []
        for raw in raw_paths:
            p = Path(raw).expanduser()
            if not p.is_absolute() or not p.is_file():
                missing.append(raw)
            else:
                files.append(p.resolve())
        if missing:
            raise ApiException(400, "file_not_found", "Файлы не найдены", {"paths": missing})

        planned: list[tuple[str, Path, MediaInfo | None]] = []
        unsupported: dict[str, str] = {}
        for f in files:
            asset_id = asset_id_for(f)
            if self.repo.get(asset_id) is not None:
                planned.append((asset_id, f, None))
                continue
            try:
                planned.append((asset_id, f, await probe(tools.ffprobe, f)))
            except UnsupportedMedia as exc:
                unsupported[str(f)] = exc.message
        if unsupported:
            raise ApiException(
                422, "unsupported_media", "Файлы не распознаны как медиа", {"files": unsupported}
            )

        assets: list[Asset] = []
        refs: list[JobRef] = []
        seen: set[str] = set()
        for asset_id, f, info in planned:
            if asset_id in seen:
                continue
            seen.add(asset_id)
            existing = self.repo.get(asset_id)
            if existing is not None:
                job_ids = self._active.get(asset_id)
                if job_ids is None and existing.status != "ready":
                    existing, job_ids = await self._restart(existing, tools)
                assets.append(existing)
                refs.extend(JobRef(job_id=j) for j in job_ids or [])
                continue
            assert info is not None
            asset = build_asset(asset_id, f, info)
            self._save(asset)
            job_ids = self._start_pipeline(asset, info)
            assets.append(self.repo.get(asset_id) or asset)
            refs.extend(JobRef(job_id=j) for j in job_ids)
        return assets, refs

    async def _restart(self, asset: Asset, tools: Tools) -> tuple[Asset, list[str]]:
        try:
            info = await probe(tools.ffprobe, Path(asset.path))
        except UnsupportedMedia as exc:
            log.warning("cannot restart import of %s: %s", asset.id, exc.message)
            asset = self._update(asset.id, status="failed")
            return asset, []
        asset = self._update(asset.id, status="importing")
        return asset, self._start_pipeline(asset, info)

    async def resume(self) -> None:
        """При старте: досоздать производные для ассетов, импорт которых прервался."""
        if self.clip_analysis is not None:
            for a in self.repo.list():
                if a.status == "ready" and self.clip_analysis.wanted(a):
                    self.clip_analysis.start(a)
        pending = [a for a in self.repo.list() if a.status == "importing"]
        if not pending:
            return
        try:
            tools = self.tools()
        except ApiException:
            log.warning("ffmpeg not found, %d interrupted imports not resumed", len(pending))
            return
        for asset in pending:
            if not Path(asset.path).is_file():
                self._update(asset.id, status="failed")
                continue
            await self._restart(asset, tools)

    async def shutdown(self) -> None:
        # Сторожей гасим до остановки задач, чтобы прерванный импорт остался `importing`
        # и был продолжен при следующем старте (resume), а не помечен `failed`.
        for w in list(self._watchers):
            w.cancel()
        await asyncio.gather(*self._watchers, return_exceptions=True)

    # ---------- цепочка ----------

    def _start_pipeline(self, asset: Asset, info: MediaInfo) -> list[str]:
        steps: list[tuple[JobKind, str, StepFn]] = []
        if info.kind == "video":
            steps.append(("proxy", "Прокси 720p", self._step_proxy))
            steps.append(("thumbs", "Превью-кадры", self._step_thumbs))
            if info.has_audio:
                steps.append(("audio", "Звук AAC", self._step_audio))
                steps.append(("waveform", "Waveform", self._step_waveform))
            if info.needs_mezzanine:
                steps.append(("mezzanine", "Mezzanine H.264", self._step_mezzanine))
        elif info.kind == "audio":
            steps.append(("audio", "Звук AAC", self._step_audio))
            steps.append(("waveform", "Waveform", self._step_waveform))
        if not steps:
            return []

        tools = self.tools()
        job_ids: list[str] = []
        for kind, message, fn in steps:
            job = self.jobs.submit(
                kind,
                self._bind(fn, tools, info, asset.id),
                asset_id=asset.id,
                resource="ffmpeg",
                message=message,
                depends_on=job_ids[-1:],
            )
            job_ids.append(job.id)
            if kind == "proxy" and self.clip_analysis is not None:
                # локальный анализ идёт параллельно цепочке и не влияет на статус ассета
                self.clip_analysis.start(asset, depends_on=[job.id])
        self._active[asset.id] = job_ids
        watcher = asyncio.create_task(self._watch(asset.id, info, job_ids), name=f"watch-{asset.id}")
        self._watchers.add(watcher)
        watcher.add_done_callback(self._watchers.discard)
        return job_ids

    @staticmethod
    def _bind(
        fn: StepFn, tools: Tools, info: MediaInfo, asset_id: str
    ) -> Callable[[JobContext], Awaitable[Any]]:
        async def run(ctx: JobContext) -> Any:
            return await fn(ctx, tools, info, asset_id)

        return run

    async def _watch(self, asset_id: str, info: MediaInfo, job_ids: list[str]) -> None:
        for j in job_ids:
            await self.jobs.wait(j)
        self._active.pop(asset_id, None)
        asset = self.repo.get(asset_id)
        if asset is None:
            return
        essential = "proxy" if info.kind == "video" else "audio"
        ok = getattr(asset.derived, essential) is not None
        self._update(asset_id, status="ready" if ok else "failed")

    # ---------- шаги ----------

    def _dir(self, asset_id: str) -> Path:
        return self.paths.asset_dir(asset_id)

    def _source(self, asset_id: str) -> Path:
        asset = self.repo.get(asset_id)
        if asset is None:
            raise JobFailed("asset_not_found", f"Ассет {asset_id} удалён")
        src = Path(asset.path)
        if not src.is_file():
            raise JobFailed("source_missing", f"Исходный файл недоступен: {src}")
        return src

    def _derived_file(self, asset_id: str, key: str) -> Path | None:
        asset = self.repo.get(asset_id)
        if asset is None or getattr(asset.derived, key) is None:
            return None
        f = self._dir(asset_id) / DERIVED_FILES[key]
        return f if f.is_file() else None

    async def _step_proxy(self, ctx: JobContext, tools: Tools, info: MediaInfo, asset_id: str) -> Asset:
        dst = self._dir(asset_id) / DERIVED_FILES["proxy"]
        if self._derived_file(asset_id, "proxy") is None:
            await make_proxy(tools.ffmpeg, self._source(asset_id), dst, info, ctx.progress)
        return self._set_derived(asset_id, "proxy")

    async def _step_audio(self, ctx: JobContext, tools: Tools, info: MediaInfo, asset_id: str) -> Asset:
        dst = self._dir(asset_id) / DERIVED_FILES["audio"]
        if self._derived_file(asset_id, "audio") is None:
            await make_audio(tools.ffmpeg, self._source(asset_id), dst, info.duration, ctx.progress)
        return self._set_derived(asset_id, "audio")

    async def _step_thumbs(self, ctx: JobContext, tools: Tools, info: MediaInfo, asset_id: str) -> Asset:
        if self._derived_file(asset_id, "thumbs") is None:
            src = self._derived_file(asset_id, "proxy") or self._source(asset_id)
            thumbs = await make_thumbs(
                tools.ffmpeg,
                src,
                self._dir(asset_id) / "thumbs",
                asset_url(asset_id, "thumbs"),
                info.duration,
                ctx.progress,
            )
            atomic.write_json(self._dir(asset_id) / DERIVED_FILES["thumbs"], dump(thumbs))
        return self._set_derived(asset_id, "thumbs")

    async def _step_waveform(self, ctx: JobContext, tools: Tools, info: MediaInfo, asset_id: str) -> Asset:
        if self._derived_file(asset_id, "waveform") is None:
            src = self._derived_file(asset_id, "audio") or self._source(asset_id)
            wf = await make_waveform(tools.ffmpeg, src, info.duration, ctx.progress)
            atomic.write_json(self._dir(asset_id) / DERIVED_FILES["waveform"], dump(wf))
        return self._set_derived(asset_id, "waveform")

    async def _step_mezzanine(self, ctx: JobContext, tools: Tools, info: MediaInfo, asset_id: str) -> Asset:
        dst = self._dir(asset_id) / DERIVED_FILES["mezzanine"]
        if self._derived_file(asset_id, "mezzanine") is None:
            await make_mezzanine(tools.ffmpeg, self._source(asset_id), dst, info, ctx.progress)
        return self._set_derived(asset_id, "mezzanine")

    # ---------- состояние ассета ----------

    def _set_derived(self, asset_id: str, key: str) -> Asset:
        asset = self.repo.get(asset_id)
        if asset is None:
            raise JobFailed("asset_not_found", f"Ассет {asset_id} удалён")
        url = asset_url(asset_id, DERIVED_FILES[key])
        if getattr(asset.derived, key) == url:
            return asset
        derived = asset.derived.model_copy(update={key: url})
        return self._update(asset_id, derived=derived)

    def _update(
        self, asset_id: str, *, status: str | None = None, derived: AssetDerived | None = None
    ) -> Asset:
        asset = self.repo.get(asset_id)
        assert asset is not None
        changes: dict[str, Any] = {}
        if status is not None:
            changes["status"] = status
        if derived is not None:
            changes["derived"] = derived
        updated = Asset.model_validate({**asset.model_dump(), **changes})
        self._save(updated)
        return updated

    def _save(self, asset: Asset) -> None:
        self.repo.save(asset)
        self.hub.publish(WsAsset(type="asset", asset=asset.model_copy(deep=True)))
