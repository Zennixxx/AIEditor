"""Низкоразрешённые серые кадры для анализа движения/склеек: ffmpeg → numpy."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import IO

import numpy as np

from app.media.ffmpeg import FfmpegError, ProgressFn, StderrTail, popen, wait_process
from app.video.motion import U8Frames

WIDTH, HEIGHT = 160, 90
FPS = 10
_FRAMES_PER_READ = 256


def _read_all(stream: IO[bytes], total_frames: float, emit: ProgressFn) -> list[bytes]:
    size = WIDTH * HEIGHT
    chunks: list[bytes] = []
    got = 0
    while True:
        data = stream.read(size * _FRAMES_PER_READ)
        if not data:
            break
        chunks.append(data)
        got += len(data) // size
        if total_frames > 0:
            emit(min(got / total_frames, 1.0))
    return chunks


async def read_gray_frames(ffmpeg: Path, src: Path, duration: float, on_progress: ProgressFn) -> U8Frames:
    """Все кадры `src` как uint8 (N, 90, 160) при 10 fps (CFR)."""
    loop = asyncio.get_running_loop()
    proc = popen(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", src, "-an", "-sn", "-dn",
         "-vf", f"fps={FPS},scale={WIDTH}:{HEIGHT}:flags=area,format=gray", "-f", "rawvideo", "pipe:1"]
    )  # fmt: skip
    err = StderrTail(proc.stderr)
    assert proc.stdout is not None

    def emit(value: float) -> None:
        loop.call_soon_threadsafe(on_progress, value)

    reader = asyncio.ensure_future(asyncio.to_thread(_read_all, proc.stdout, duration * FPS, emit))
    try:
        code = await wait_process(proc)
        chunks = await reader
    except BaseException:
        reader.cancel()
        raise
    if code != 0:
        raise FfmpegError(f"ffmpeg (motion) завершился с кодом {code}: {err.text() or 'нет вывода'}")
    raw = b"".join(chunks)
    n = len(raw) // (WIDTH * HEIGHT)
    return np.frombuffer(raw[: n * WIDTH * HEIGHT], dtype=np.uint8).reshape(n, HEIGHT, WIDTH)
