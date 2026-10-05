"""Энергия движения клипа: средняя абсолютная разница соседних кадров — CONTRACT §4 (ClipAnalysis.motion).

Вход — серые кадры 160×90 при 10 fps (`video/frames.py`). Скачки на склейках не считаются
движением: значение на границе шота заменяется соседним.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

type U8Frames = npt.NDArray[np.uint8]

SMOOTH_WINDOW = 3
NORM_PERCENTILE = 99.0
# Средняя доля яркости (0.003 ≈ 0.8 из 255): меньшая разница — шум, статичное видео не растягивается до 1.
NOISE_FLOOR = 0.003


def raw_motion(frames: U8Frames) -> npt.NDArray[np.float64]:
    """Средняя |разница| соседних кадров, 0..1; длина = число кадров (значение 0 повторяет значение 1)."""
    n = frames.shape[0]
    if n == 0:
        return np.zeros(0)
    if n == 1:
        return np.zeros(1)
    f = frames.astype(np.int16)
    diff = np.abs(f[1:] - f[:-1]).reshape(n - 1, -1).mean(axis=1) / 255.0
    return np.concatenate([diff[:1], diff])


def motion_curve(frames: U8Frames, cuts: list[int] | None = None, smooth: int = SMOOTH_WINDOW) -> list[float]:
    """Сглаженная нормализованная (0..1) кривая движения.

    `cuts` — индексы кадров, с которых начинается новый шот: там разница не движение.
    """
    m = raw_motion(frames)
    if m.size == 0:
        return []
    for c in cuts or []:
        if 0 < c < m.size:
            m[c] = m[c - 1] if c + 1 >= m.size else min(m[c - 1], m[c + 1])
    if smooth > 1 and m.size >= smooth:
        kernel = np.ones(smooth) / smooth
        padded = np.pad(m, (smooth // 2, smooth - 1 - smooth // 2), mode="edge")
        m = np.convolve(padded, kernel, mode="valid")
    scale = max(float(np.percentile(m, NORM_PERCENTILE)), NOISE_FLOOR)
    return [round(float(v), 3) for v in np.clip(m / scale, 0.0, 1.0)]
