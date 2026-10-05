"""Waveform: моно 22050 Гц, пики min/max на 256 сэмплов, int8 — CONTRACT §3 (Waveform)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import IO

import numpy as np
import numpy.typing as npt

from app.media.ffmpeg import FfmpegError, ProgressFn, StderrTail, popen, wait_process
from app.models.gen import Waveform

SAMPLE_RATE = 22050
SAMPLES_PER_PEAK = 256
_BLOCKS_PER_READ = 1024


def peaks_from_pcm(samples: npt.NDArray[np.int16], samples_per_peak: int = SAMPLES_PER_PEAK) -> list[int]:
    """int16-сэмплы → [min, max, min, max, …] в int8 (старший байт; неполный хвост — тоже блок)."""
    if samples.size == 0:
        return []
    pad = (-samples.size) % samples_per_peak
    s = samples.astype(np.int16, copy=False)
    if pad:
        # хвост дополняем его же последним значением, чтобы не исказить min/max
        s = np.concatenate([s, np.full(pad, s[-1], dtype=np.int16)])
    blocks = s.reshape(-1, samples_per_peak)
    mn = blocks.min(axis=1) >> 8
    mx = blocks.max(axis=1) >> 8
    return np.column_stack((mn, mx)).astype(np.int8).ravel().tolist()


def _read_peaks(stream: IO[bytes], total_samples: float, on_progress: ProgressFn) -> list[int]:
    chunk = SAMPLES_PER_PEAK * _BLOCKS_PER_READ * 2
    peaks: list[int] = []
    rest = b""
    read = 0
    while True:
        data = stream.read(chunk)
        if not data:
            break
        buf = rest + data
        usable = len(buf) - len(buf) % (SAMPLES_PER_PEAK * 2)
        rest = buf[usable:]
        if usable:
            peaks.extend(peaks_from_pcm(np.frombuffer(buf[:usable], dtype="<i2")))
            read += usable // 2
            if total_samples > 0:
                on_progress(min(read / total_samples, 1.0))
    if len(rest) >= 2:
        peaks.extend(peaks_from_pcm(np.frombuffer(rest[: len(rest) - len(rest) % 2], dtype="<i2")))
    return peaks


async def make_waveform(ffmpeg: Path, src: Path, duration: float, on_progress: ProgressFn) -> Waveform:
    loop = asyncio.get_running_loop()
    proc = popen(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", src, "-vn", "-sn", "-dn",
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1"]
    )  # fmt: skip
    err = StderrTail(proc.stderr)
    assert proc.stdout is not None

    def emit(value: float) -> None:
        loop.call_soon_threadsafe(on_progress, value)

    reader = asyncio.ensure_future(asyncio.to_thread(_read_peaks, proc.stdout, duration * SAMPLE_RATE, emit))
    try:
        code = await wait_process(proc)
        peaks = await reader
    except BaseException:
        reader.cancel()
        raise
    if code != 0:
        raise FfmpegError(f"ffmpeg (waveform) завершился с кодом {code}: {err.text() or 'нет вывода'}")
    return Waveform(sample_rate=SAMPLE_RATE, samples_per_peak=SAMPLES_PER_PEAK, channels=1, peaks=peaks)
