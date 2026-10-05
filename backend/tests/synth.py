"""Синтетические треки для тестов анализа музыки."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import numpy.typing as npt

from app.audio.bass import SR

type F32 = npt.NDArray[np.float32]


def kick(sr: int = SR, freq: float = 55.0, length: float = 0.18) -> F32:
    t = np.arange(int(length * sr)) / sr
    env = np.exp(-t * 28.0) * np.minimum(t / 0.002, 1.0)
    return (np.sin(2 * np.pi * freq * t) * env).astype(np.float32)


def hat(sr: int = SR, length: float = 0.04, seed: int = 1) -> F32:
    rng = np.random.default_rng(seed)
    n = int(length * sr)
    env = np.exp(-np.arange(n) / sr * 120.0)
    return (rng.standard_normal(n) * env * 0.25).astype(np.float32)


def click_track(
    duration: float,
    bpm: float = 120.0,
    gains: Sequence[tuple[float, float, float]] | None = None,
    sr: int = SR,
) -> tuple[F32, np.ndarray]:
    """Бас-удар на каждой доле, хэт на восьмых, фоновый тон 220 Гц.

    `gains` — [(start, end, gain)]: громкость по участкам (по умолчанию 1.0).
    Возвращает (сигнал, времена бас-ударов).
    """
    n = int(duration * sr)
    env = np.ones(n, dtype=np.float32)
    for a, b, g in gains or []:
        env[int(a * sr) : int(b * sr)] = g
    y = np.zeros(n, dtype=np.float32)

    def place(snd: F32, t: float) -> None:
        i = round(t * sr)
        j = min(n, i + snd.size)
        if i < n:
            y[i:j] += env[i] * snd[: j - i]

    period = 60.0 / bpm
    k, h = kick(sr), hat(sr)
    hits = np.arange(0.25, duration - 0.3, period)
    for t in hits:
        place(k, float(t))
    for t in np.arange(0.25 + period / 2, duration - 0.1, period):
        place(h, float(t))
    y += (0.05 * np.sin(2 * np.pi * 220 * np.arange(n) / sr) * env).astype(np.float32)
    return np.clip(y, -1, 1), hits
