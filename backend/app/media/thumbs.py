"""Превью-кадры: 1 кадр в `interval` секунд, тайл 160×90, JPG-атласы 10×10 — CONTRACT §3 (Thumbs)."""

from __future__ import annotations

import math
import shutil
from pathlib import Path

from app.media.ffmpeg import FfmpegError, ProgressFn, run_ffmpeg
from app.models.gen import Thumbs
from app.storage import atomic

TILE_W, TILE_H = 160, 90
COLUMNS, ROWS = 10, 10
MAX_THUMBS = 600
JPEG_QSCALE = "4"  # mjpeg -q:v 4 ≈ JPEG quality 80


def thumb_interval(duration: float) -> float:
    """1 с, а для длинных роликов шаг больше, чтобы кадров было ≤ MAX_THUMBS."""
    return float(max(1, math.ceil(duration / MAX_THUMBS)))


async def make_thumbs(
    ffmpeg: Path, src: Path, out_dir: Path, url_prefix: str, duration: float, on_progress: ProgressFn
) -> Thumbs:
    """Кадры → `out_dir/{n}.jpg` (атласы); возвращает описание для thumbs.json.

    Два прохода: сначала отдельные кадры (точный `count`), затем склейка в атласы.
    """
    interval = thumb_interval(duration)
    work = out_dir.with_name(f"{out_dir.name}.part")
    frames, atlases = work / "frames", work / "atlases"
    shutil.rmtree(work, ignore_errors=True)
    frames.mkdir(parents=True)
    atlases.mkdir()
    try:
        vf = (
            f"fps=1/{interval:g},"
            f"scale={TILE_W}:{TILE_H}:force_original_aspect_ratio=decrease,"
            f"pad={TILE_W}:{TILE_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
        )
        await run_ffmpeg(
            ffmpeg,
            ["-i", str(src), "-an", "-sn", "-dn", "-vf", vf, "-frames:v", str(MAX_THUMBS),
             "-start_number", "0", str(frames / "%05d.bmp")],
            duration=duration,
            on_progress=lambda p: on_progress(p * 0.9),
        )  # fmt: skip
        count = len(list(frames.glob("*.bmp")))
        if count == 0:
            raise FfmpegError("ffmpeg не выдал ни одного кадра")
        await run_ffmpeg(
            ffmpeg,
            ["-framerate", "1", "-start_number", "0", "-i", str(frames / "%05d.bmp"),
             "-vf", f"tile={COLUMNS}x{ROWS}", "-fps_mode", "passthrough", "-q:v", JPEG_QSCALE,
             "-start_number", "0", str(atlases / "%d.jpg")],
        )  # fmt: skip
        sprites = len(list(atlases.glob("*.jpg")))
        expected = math.ceil(count / (COLUMNS * ROWS))
        if sprites != expected:
            raise FfmpegError(f"ожидалось {expected} атласов, получено {sprites}")
        atomic.replace_dir(atlases, out_dir)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    on_progress(1.0)
    return Thumbs(
        interval=interval,
        tile_width=TILE_W,
        tile_height=TILE_H,
        columns=COLUMNS,
        count=count,
        sprites=[f"{url_prefix}/{i}.jpg" for i in range(sprites)],
    )
