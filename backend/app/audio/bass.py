"""Бас-онсеты и широкополосные онсеты — docs/BACKEND.md, фаза 2.

Чистая DSP на numpy/librosa: вызывается из рабочего процесса (ProcessPoolExecutor).
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np
import numpy.typing as npt
from scipy.signal import butter, sosfiltfilt

type F32 = npt.NDArray[np.float32]
type F64 = npt.NDArray[np.float64]

SR = 22050
HOP = 256
REFINE_BEFORE = 0.045  # онсет по спектральному потоку приходит раньше самой атаки (окно STFT)
REFINE_AFTER = 0.02
RMS_FRAME = 256
RMS_HOP = 32
BROADBAND_EXTRA_DELTA = 0.1  # «пониженная чувствительность» широкополосных онсетов


@dataclass(frozen=True, slots=True)
class Onsets:
    times: F64
    strength: F64  # 0..1


def lowpass(y: F32, cutoff_hz: float, sr: int = SR) -> F32:
    cutoff = min(cutoff_hz, sr / 2 * 0.95)
    sos = butter(4, cutoff, btype="low", fs=sr, output="sos")
    return sosfiltfilt(sos, y).astype(np.float32)


def onset_envelope(y: F32, sr: int = SR) -> F64:
    return librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP).astype(np.float64)


def delta_for(sensitivity: float) -> float:
    return 0.02 + (1.0 - sensitivity) * 0.3


def detect_frames(env: F64, sr: int, sensitivity: float, min_gap_sec: float, extra_delta: float = 0.0) -> F64:
    wait = max(1, int(min_gap_sec * sr / HOP))
    frames = librosa.onset.onset_detect(
        onset_envelope=env,
        sr=sr,
        hop_length=HOP,
        delta=delta_for(sensitivity) + extra_delta,
        wait=wait,
        backtrack=False,
        units="frames",
    )
    return np.asarray(frames, dtype=np.float64)


def normalised_strength(env: F64, frames: F64) -> F64:
    if frames.size == 0:
        return np.zeros(0)
    peak = float(np.percentile(env, 99))
    if peak <= 1e-9:
        peak = float(env.max()) or 1.0
    return np.clip(env[frames.astype(int)] / peak, 0.0, 1.0)


def refine_times(y: F32, times: F64, sr: int = SR) -> F64:
    """Сдвинуть каждый онсет на максимум производной RMS в окне вокруг него — на атаку."""
    if times.size == 0:
        return times
    rms = librosa.feature.rms(y=y, frame_length=RMS_FRAME, hop_length=RMS_HOP, center=True)[0]
    d = np.diff(rms, prepend=rms[0])
    step = RMS_HOP / sr
    out = np.empty_like(times)
    for i, t in enumerate(times):
        lo = max(0, round((t - REFINE_BEFORE) / step))
        hi = min(d.size, round((t + REFINE_AFTER) / step) + 1)
        out[i] = (lo + int(np.argmax(d[lo:hi]))) * step if hi > lo else t
    return out


def _dedupe(times: F64, strength: F64, min_gap: float) -> Onsets:
    """После уточнения два онсета могли сойтись — оставляем более сильный."""
    if times.size == 0:
        return Onsets(times, strength)
    order = np.argsort(times, kind="stable")
    times, strength = times[order], strength[order]
    keep_t: list[float] = [float(times[0])]
    keep_s: list[float] = [float(strength[0])]
    for t, s in zip(times[1:], strength[1:], strict=True):
        if t - keep_t[-1] < min_gap * 0.5:
            if s > keep_s[-1]:
                keep_t[-1], keep_s[-1] = float(t), float(s)
        else:
            keep_t.append(float(t))
            keep_s.append(float(s))
    return Onsets(np.asarray(keep_t), np.asarray(keep_s))


def detect_bass(
    y: F32, sr: int, cutoff_hz: float, sensitivity: float, min_gap_sec: float
) -> tuple[Onsets, F64]:
    """Бас-онсеты: LP → onset_strength → onset_detect → уточнение. Возвращает и огибающую баса."""
    yb = lowpass(y, cutoff_hz, sr)
    env = onset_envelope(yb, sr)
    frames = detect_frames(env, sr, sensitivity, min_gap_sec)
    strength = normalised_strength(env, frames)
    times = refine_times(yb, frames * HOP / sr, sr)
    return _dedupe(times, strength, min_gap_sec), env


def detect_broadband(
    y: F32, sr: int, sensitivity: float, min_gap_sec: float, env: F64 | None = None
) -> tuple[Onsets, F64]:
    env = onset_envelope(y, sr) if env is None else env
    frames = detect_frames(env, sr, sensitivity, min_gap_sec, BROADBAND_EXTRA_DELTA)
    strength = normalised_strength(env, frames)
    times = refine_times(y, frames * HOP / sr, sr)
    return _dedupe(times, strength, min_gap_sec), env
