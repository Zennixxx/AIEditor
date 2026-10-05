"""Прокси 720p (H.264, GOP 10, без B-кадров) и извлечение звука в audio.m4a."""

from __future__ import annotations

import contextlib
from pathlib import Path

from app.media.ffmpeg import ProgressFn, run_ffmpeg
from app.media.ffprobe import MediaInfo
from app.storage import atomic

PROXY_HEIGHT = 720
AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k"]


def cfr_args(info: MediaInfo) -> list[str]:
    """Для VFR-исходников — постоянная частота round(fps)."""
    if info.vfr and info.fps:
        return ["-fps_mode", "cfr", "-r", str(max(1, round(info.fps)))]
    return []


def proxy_height(info: MediaInfo) -> int:
    h = min(PROXY_HEIGHT, info.height or PROXY_HEIGHT)
    return max(2, h - h % 2)


async def encode_to(
    ffmpeg: Path, args: list[str], dst: Path, duration: float, on_progress: ProgressFn
) -> None:
    """ffmpeg пишет во временный файл рядом с `dst`, затем атомарная подмена."""
    tmp = atomic.part_path(dst)
    try:
        await run_ffmpeg(ffmpeg, [*args, str(tmp)], duration=duration, on_progress=on_progress)
        atomic.replace(tmp, dst)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


async def make_proxy(ffmpeg: Path, src: Path, dst: Path, info: MediaInfo, on_progress: ProgressFn) -> None:
    args = [
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        "-vf", f"scale=-2:{proxy_height(info)}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "10", "-bf", "0",
        "-pix_fmt", "yuv420p",
        *cfr_args(info),
        *AUDIO_ARGS,
        "-movflags", "+faststart",
    ]  # fmt: skip
    await encode_to(ffmpeg, args, dst, info.duration, on_progress)


async def make_audio(ffmpeg: Path, src: Path, dst: Path, duration: float, on_progress: ProgressFn) -> None:
    args = ["-i", str(src), "-map", "0:a:0", "-vn", "-sn", "-dn", *AUDIO_ARGS, "-movflags", "+faststart"]
    await encode_to(ffmpeg, args, dst, duration, on_progress)
