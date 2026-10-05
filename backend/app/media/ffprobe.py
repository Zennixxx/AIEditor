"""ffprobe → описание медиа → `Asset` (CONTRACT §3)."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.jobs.manager import JobFailed
from app.media.ffmpeg import run_ffprobe
from app.models.gen import Asset, AssetDerived, AssetKind

BROWSER_VIDEO_CODECS = {"hevc", "vp9", "av1"}
H264_BROWSER_PIX_FMTS = {"yuv420p", "yuvj420p"}
BROWSER_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac"}
BROWSER_IMAGE_CODECS = {"mjpeg", "png", "webp", "gif", "bmp"}
VFR_TOLERANCE = 0.01
MAX_SANE_FPS = 240.0


class UnsupportedMedia(JobFailed):
    def __init__(self, message: str) -> None:
        super().__init__("unsupported_media", message)


@dataclass(frozen=True, slots=True)
class MediaInfo:
    kind: AssetKind
    duration: float
    codec: str
    has_audio: bool
    browser_decodable: bool
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    vfr: bool = False
    high_bit_depth: bool = False

    @property
    def needs_mezzanine(self) -> bool:
        if self.kind != "video":
            return False
        return not self.browser_decodable or (self.codec == "hevc" and self.high_bit_depth)


def _rate(value: Any) -> float | None:
    if not isinstance(value, str) or "/" not in value:
        return None
    num, _, den = value.partition("/")
    try:
        n, d = float(num), float(den)
    except ValueError:
        return None
    if n <= 0 or d <= 0:
        return None
    return n / d


def _float(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f >= 0 else None


def _rotation(stream: dict[str, Any]) -> int:
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                return int(float(sd["rotation"]))
            except (TypeError, ValueError):
                pass
    try:
        return int(float((stream.get("tags") or {}).get("rotate", 0)))
    except (TypeError, ValueError):
        return 0


_HIGH_BIT_RE = re.compile(r"(9|10|12|14|16)(le|be)$")


def _is_high_bit(pix_fmt: str) -> bool:
    """yuv420p10le, p010le, gray12le… — больше 8 бит на компоненту."""
    return bool(_HIGH_BIT_RE.search(pix_fmt))


def parse_probe(data: dict[str, Any]) -> MediaInfo:
    """Чистая функция над выводом `ffprobe -show_format -show_streams -print_format json`."""
    streams: list[dict[str, Any]] = data.get("streams") or []
    fmt: dict[str, Any] = data.get("format") or {}
    video = next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")
        ),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        raise UnsupportedMedia("В файле нет видео- или аудиопотока")

    format_name = str(fmt.get("format_name", ""))
    duration = (
        _float(fmt.get("duration"))
        or (_float(video.get("duration")) if video else None)
        or (_float(audio.get("duration")) if audio else None)
        or 0.0
    )

    if video is not None:
        codec = str(video.get("codec_name", "unknown"))
        is_image = "image2" in format_name or format_name.endswith("_pipe")
        width, height = int(video.get("width") or 0) or None, int(video.get("height") or 0) or None
        if width and height and abs(_rotation(video)) % 180 == 90:
            width, height = height, width
        if is_image:
            return MediaInfo(
                kind="image",
                duration=0.0,
                codec=codec,
                has_audio=False,
                browser_decodable=codec in BROWSER_IMAGE_CODECS,
                width=width,
                height=height,
            )
        r_rate, avg_rate = _rate(video.get("r_frame_rate")), _rate(video.get("avg_frame_rate"))
        fps = r_rate or avg_rate
        if fps is not None and fps > MAX_SANE_FPS and avg_rate is not None:
            fps = avg_rate
        vfr = bool(r_rate and avg_rate and abs(r_rate - avg_rate) / r_rate > VFR_TOLERANCE)
        pix_fmt = str(video.get("pix_fmt", ""))
        high_bit = _is_high_bit(pix_fmt)
        # h264 — только 8-bit 4:2:0; hevc/vp9/av1 — да; прочее (prores, dnxhd…) — нет
        decodable = pix_fmt in H264_BROWSER_PIX_FMTS if codec == "h264" else codec in BROWSER_VIDEO_CODECS
        if duration <= 0:
            raise UnsupportedMedia("Не удалось определить длительность видео")
        return MediaInfo(
            kind="video",
            duration=duration,
            codec=codec,
            has_audio=audio is not None,
            browser_decodable=decodable,
            width=width,
            height=height,
            fps=round(fps, 3) if fps else None,
            vfr=vfr,
            high_bit_depth=high_bit,
        )

    assert audio is not None
    codec = str(audio.get("codec_name", "unknown"))
    if duration <= 0:
        raise UnsupportedMedia("Не удалось определить длительность аудио")
    return MediaInfo(
        kind="audio",
        duration=duration,
        codec=codec,
        has_audio=True,
        browser_decodable=codec in BROWSER_AUDIO_CODECS or codec.startswith("pcm_"),
    )


async def probe(ffprobe: Path, path: Path) -> MediaInfo:
    try:
        data = await run_ffprobe(ffprobe, path)
    except JobFailed as exc:
        raise UnsupportedMedia(f"ffprobe не смог прочитать файл: {exc.message}") from exc
    return parse_probe(data)


def build_asset(asset_id: str, path: Path, info: MediaInfo) -> Asset:
    return Asset(
        id=asset_id,
        kind=info.kind,
        name=path.name,
        path=str(path),
        duration=info.duration,
        width=info.width,
        height=info.height,
        fps=info.fps,
        has_audio=info.has_audio,
        codec=info.codec,
        browser_decodable=info.browser_decodable,
        status="ready" if info.kind == "image" else "importing",
        derived=AssetDerived(),
    )
