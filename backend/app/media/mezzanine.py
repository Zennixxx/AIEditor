"""Mezzanine: полное разрешение, H.264 CRF 16 — для исходников, которые браузер не декодирует."""

from __future__ import annotations

from pathlib import Path

from app.media.ffmpeg import ProgressFn
from app.media.ffprobe import MediaInfo
from app.media.proxy import AUDIO_ARGS, cfr_args, encode_to


async def make_mezzanine(
    ffmpeg: Path, src: Path, dst: Path, info: MediaInfo, on_progress: ProgressFn
) -> None:
    args = [
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        # libx264 требует чётные размеры
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
        *cfr_args(info),
        *AUDIO_ARGS,
        "-movflags", "+faststart",
    ]  # fmt: skip
    await encode_to(ffmpeg, args, dst, info.duration, on_progress)
