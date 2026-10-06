from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import math
import shutil
import subprocess
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Literal

from app.config import Settings, ffmpeg_bin, rife_bin
from app.errors import ApiException
from app.jobs.events import EventHub
from app.jobs.manager import JobContext, JobFailed, JobManager
from app.media.ffmpeg import ProgressFn, StderrTail, popen, run_ffmpeg, wait_process
from app.models.gen import Asset, AssetDerived, AssetParent, WsAsset
from app.storage import atomic
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)

FACTORS = (2, 4, 8, 16)
RIFE_MODEL = "rife-v4.6"
DEFAULT_FPS = 30.0
POLL_INTERVAL = 0.25
PROXY_HEIGHT = 720
OUTPUT_NAME = "interpolated.mp4"
PROXY_NAME = "proxy.mp4"
TIME_DIGITS = 6

EXTRACT_SHARE = 0.1
INTERPOLATE_SHARE = 0.75


@dataclass(frozen=True, slots=True)
class FrameRange:
    first: int
    last: int
    fps: float

    @property
    def count(self) -> int:
        return self.last - self.first + 1

    @property
    def start(self) -> float:
        return self.first / self.fps


def source_fps(asset: Asset) -> float:
    return asset.fps if asset.fps and asset.fps > 0 else DEFAULT_FPS


def frame_range(asset: Asset, source_in: float, source_out: float) -> FrameRange:
    fps = source_fps(asset)
    lo = max(0.0, source_in)
    hi = min(source_out, asset.duration)
    if lo >= hi:
        raise ApiException(
            422,
            "bad_range",
            f"Пустой диапазон [{source_in}, {source_out}] для ассета длиной {asset.duration}",
        )
    last_frame = max(0, math.ceil(asset.duration * fps - 1e-6) - 1)
    first = min(math.floor(lo * fps + 1e-6), last_frame)
    last = min(max(math.ceil(hi * fps - 1e-6), first + 1), last_frame)
    if last <= first:
        raise ApiException(422, "bad_range", "В диапазоне меньше двух кадров")
    return FrameRange(first, last, fps)


def derived_id(parent_id: str, fr: FrameRange, factor: int) -> str:
    key = f"{parent_id}|{fr.first}|{fr.last}|{factor}|interpolated"
    return "ast_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def output_rate(fps: float, factor: int) -> Fraction:
    return Fraction(fps).limit_denominator(1001) * factor


def output_count(fr: FrameRange, factor: int) -> int:
    return (fr.count - 1) * factor + 1


def target_height(asset: Asset, max_height: int) -> int | None:
    if not asset.height:
        return None
    h = asset.height if max_height <= 0 else min(asset.height, max_height)
    return max(2, h - h % 2)


def scale_filter(height: int | None) -> str:
    if height is None:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    return f"scale=-2:{height}"


def png_count(folder: Path) -> int:
    with contextlib.suppress(OSError):
        return sum(1 for _ in folder.glob("*.png"))
    return 0


def remove_tree(folder: Path) -> None:
    for _ in range(20):
        shutil.rmtree(folder, ignore_errors=True)
        if not folder.exists():
            return
        time.sleep(0.1)
    log.warning("cannot remove temp dir %s", folder)


class InterpolationService:
    def __init__(
        self,
        settings: Settings,
        paths: DataPaths,
        repo: AssetsRepo,
        jobs: JobManager,
        hub: EventHub,
    ) -> None:
        self.settings = settings
        self.paths = paths
        self.repo = repo
        self.jobs = jobs
        self.hub = hub
        self._inflight: dict[str, str] = {}

    def cached(self, parent_id: str, fr: FrameRange, factor: int) -> Asset | None:
        start, end = fr.first / fr.fps, fr.last / fr.fps
        for a in self.repo.list():
            p = a.parent
            if p is None or p.asset_id != parent_id or p.factor != factor or a.status != "ready":
                continue
            if p.source_in <= start + 1e-6 and p.source_out >= end - 1e-6 and Path(a.path).is_file():
                return a
        return None

    def request(self, asset: Asset, source_in: float, source_out: float, factor: int) -> str:
        if asset.kind != "video" or asset.parent is not None:
            raise ApiException(422, "not_video", f"Ассет {asset.id} не видео")
        ffmpeg = ffmpeg_bin(self.settings)
        if ffmpeg is None:
            raise ApiException(503, "ffmpeg_missing", "ffmpeg не найден (tools/bin или FFMPEG_PATH)")
        fr = frame_range(asset, source_in, source_out)
        new_id = derived_id(asset.id, fr, factor)
        running = self._inflight.get(new_id)
        if running is not None and (job := self.jobs.get(running)) and job.status in ("queued", "running"):
            return running

        async def run(ctx: JobContext) -> Asset:
            hit = self.cached(asset.id, fr, factor)
            if hit is not None:
                ctx.progress(1.0, "Из кэша")
                return hit
            return await self._run(ctx, ffmpeg, asset, fr, factor, new_id)

        hit = self.cached(asset.id, fr, factor)
        job = self.jobs.submit(
            "interpolate",
            run,
            asset_id=asset.id,
            resource="light" if hit is not None else "rife",
            message=f"Интерполяция ×{factor}",
        )
        self._inflight[new_id] = job.id
        return job.id

    def _source(self, asset: Asset) -> Path:
        src = Path(asset.path)
        if src.is_file():
            return src
        mezz = self.paths.asset_dir(asset.id) / "mezzanine.mp4"
        if mezz.is_file():
            return mezz
        raise JobFailed("source_missing", f"Исходный файл недоступен: {src}")

    async def _run(
        self, ctx: JobContext, ffmpeg: Path, asset: Asset, fr: FrameRange, factor: int, new_id: str
    ) -> Asset:
        out_dir = self.paths.asset_dir(new_id)
        work = out_dir / ".work"
        remove_tree(work)
        frames_in, frames_out = work / "in", work / "out"
        frames_in.mkdir(parents=True)
        frames_out.mkdir(parents=True)
        try:
            ctx.progress(0.0, "Извлечение кадров")
            height = target_height(asset, self.settings.aieditor_interpolate_max_height)
            await extract_frames(
                ffmpeg, self._source(asset), frames_in, fr, height, lambda p: ctx.progress(p * EXTRACT_SHARE)
            )
            got = png_count(frames_in)
            if got < 2:
                raise JobFailed("no_frames", "Не удалось извлечь кадры диапазона")
            fr = FrameRange(fr.first, fr.first + got - 1, fr.fps)

            def on_interp(p: float) -> None:
                ctx.progress(EXTRACT_SHARE + p * INTERPOLATE_SHARE)

            quality = await self._interpolate(ffmpeg, frames_in, frames_out, fr, factor, ctx, on_interp)
            count = png_count(frames_out)
            rate = output_rate(fr.fps, factor)
            ctx.progress(EXTRACT_SHARE + INTERPOLATE_SHARE, "Сборка видео")
            base = EXTRACT_SHARE + INTERPOLATE_SHARE
            await encode_outputs(
                ffmpeg,
                frames_out,
                out_dir,
                rate,
                round(fr.start, TIME_DIGITS),
                count,
                proxy_height(height or asset.height),
                lambda p: ctx.progress(base + p * (1 - base)),
            )
        finally:
            remove_tree(work)

        out_fps = float(rate)
        start = round(fr.start, TIME_DIGITS)
        end = round(fr.start + (count - 1) / out_fps, TIME_DIGITS)
        scaled_w = None
        if asset.width and asset.height and height:
            scaled_w = round(asset.width * height / asset.height / 2) * 2
        derived = Asset(
            id=new_id,
            kind="video",
            name=f"{asset.name} ×{factor}",
            path=str(out_dir / OUTPUT_NAME),
            duration=round(end + 1 / out_fps, TIME_DIGITS),
            width=scaled_w or asset.width,
            height=height or asset.height,
            fps=round(out_fps, 3),
            has_audio=False,
            codec="h264",
            browser_decodable=True,
            status="ready",
            derived=AssetDerived(proxy=f"/api/assets/{new_id}/{PROXY_NAME}"),
            parent=AssetParent(
                asset_id=asset.id,
                kind="interpolated",
                factor=factor,
                source_in=start,
                source_out=end,
                quality=quality,
            ),
        )
        self.repo.save(derived)
        self.hub.publish(WsAsset(type="asset", asset=derived.model_copy(deep=True)))
        return derived

    async def _interpolate(
        self,
        ffmpeg: Path,
        frames_in: Path,
        frames_out: Path,
        fr: FrameRange,
        factor: int,
        ctx: JobContext,
        on_progress: ProgressFn,
    ) -> Literal["rife", "fallback"]:
        rife = rife_bin(self.settings)
        if rife is not None:
            ctx.progress(EXTRACT_SHARE, "RIFE")
            try:
                await run_rife(rife, frames_in, frames_out, fr.count * factor, on_progress)
                keep = output_count(fr, factor)
                if png_count(frames_out) >= keep:
                    for i in range(keep + 1, fr.count * factor + 1):
                        with contextlib.suppress(FileNotFoundError):
                            (frames_out / f"{i:08d}.png").unlink()
                    return "rife"
                log.warning("rife produced %d frames, expected %d", png_count(frames_out), keep)
            except JobFailed as exc:
                log.warning("rife failed, falling back to minterpolate: %s", exc.message)
            remove_tree(frames_out)
            frames_out.mkdir(parents=True, exist_ok=True)
        ctx.progress(EXTRACT_SHARE, "Интерполяция ffmpeg (fallback)")
        await minterpolate(ffmpeg, frames_in, frames_out, fr, factor, on_progress)
        return "fallback"


def proxy_height(height: int | None) -> int:
    h = min(PROXY_HEIGHT, height or PROXY_HEIGHT)
    return max(2, h - h % 2)


async def extract_frames(
    ffmpeg: Path, src: Path, dst: Path, fr: FrameRange, height: int | None, on_progress: ProgressFn
) -> None:
    seek = max(0.0, (fr.first - 0.5) / fr.fps)
    args = [
        "-ss", f"{seek:.6f}", "-i", str(src),
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", scale_filter(height), "-fps_mode", "passthrough",
        "-frames:v", str(fr.count),
        "-start_number", "1",
        str(dst / "%08d.png"),
    ]  # fmt: skip
    await run_ffmpeg(ffmpeg, args, duration=fr.count / fr.fps, on_progress=on_progress)


async def run_rife(rife: Path, src: Path, dst: Path, total: int, on_progress: ProgressFn) -> None:
    model = rife.parent / RIFE_MODEL
    cmd = [rife, "-i", src, "-o", dst, "-n", str(total), "-j", "1:2:2", "-f", "%08d.png"]
    if model.is_dir():
        cmd[1:1] = ["-m", model]
    proc = popen(cmd, stdout=subprocess.DEVNULL)
    err = StderrTail(proc.stderr)
    waiter = asyncio.ensure_future(wait_process(proc))
    try:
        while not waiter.done():
            on_progress(min(png_count(dst) / total, 1.0))
            await asyncio.wait([waiter], timeout=POLL_INTERVAL)
        code = waiter.result()
    except BaseException:
        waiter.cancel()
        with contextlib.suppress(BaseException):
            await waiter
        raise
    if code != 0:
        raise JobFailed("rife_failed", f"rife-ncnn-vulkan завершился с кодом {code}: {err.text()}")


async def minterpolate(
    ffmpeg: Path, src: Path, dst: Path, fr: FrameRange, factor: int, on_progress: ProgressFn
) -> None:
    rate = output_rate(fr.fps, factor)
    args = [
        "-framerate", str(output_rate(fr.fps, 1)), "-start_number", "1", "-i", str(src / "%08d.png"),
        "-vf", f"tpad=stop=4:stop_mode=clone,minterpolate=fps={rate}:mi_mode=mci:mc_mode=aobmc:vsbmc=1",
        "-frames:v", str(output_count(fr, factor)),
        "-start_number", "1",
        str(dst / "%08d.png"),
    ]  # fmt: skip
    await run_ffmpeg(ffmpeg, args, duration=fr.count / fr.fps, on_progress=on_progress)


async def encode_outputs(
    ffmpeg: Path,
    frames: Path,
    out_dir: Path,
    rate: Fraction,
    start: float,
    count: int,
    proxy_h: int,
    on_progress: ProgressFn,
) -> None:
    main, proxy = out_dir / OUTPUT_NAME, out_dir / PROXY_NAME
    main_tmp, proxy_tmp = atomic.part_path(main), atomic.part_path(proxy)
    graph = f"[0:v]split=2[a][b];[a]scale=trunc(iw/2)*2:trunc(ih/2)*2[m];[b]scale=-2:{proxy_h}[p]"
    common = ["-pix_fmt", "yuv420p", "-g", "10", "-bf", "0", "-output_ts_offset", f"{start:.6f}"]
    args = [
        "-framerate", str(rate), "-start_number", "1", "-i", str(frames / "%08d.png"),
        "-filter_complex", graph,
        "-map", "[m]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", *common,
        "-movflags", "+faststart", str(main_tmp),
        "-map", "[p]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", *common,
        "-movflags", "+faststart", str(proxy_tmp),
    ]  # fmt: skip
    try:
        await run_ffmpeg(ffmpeg, args, duration=count / float(rate), on_progress=on_progress)
        atomic.replace(main_tmp, main)
        atomic.replace(proxy_tmp, proxy)
    finally:
        for f in (main_tmp, proxy_tmp):
            with contextlib.suppress(FileNotFoundError):
                f.unlink()
