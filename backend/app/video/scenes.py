"""Склейки внутри исходника по разнице гистограмм соседних кадров — границы shots (CONTRACT §4)."""

from __future__ import annotations

from itertools import pairwise

import numpy as np
import numpy.typing as npt

type U8Frames = npt.NDArray[np.uint8]

BINS = 32
CUT_THRESHOLD = 0.4  # половина L1-расстояния нормированных гистограмм, 0..1
MIN_SHOT_SEC = 0.3


def histogram_distances(frames: U8Frames) -> npt.NDArray[np.float64]:
    """d[i] — расстояние между кадрами i−1 и i (d[0] = 0), 0..1."""
    n = frames.shape[0]
    d = np.zeros(n)
    if n < 2:
        return d
    flat = frames.reshape(n, -1)
    hists = np.stack([np.bincount(row >> 3, minlength=BINS)[:BINS] for row in flat]).astype(np.float64)
    hists /= hists.sum(axis=1, keepdims=True)
    d[1:] = 0.5 * np.abs(hists[1:] - hists[:-1]).sum(axis=1)
    return d


def detect_cuts(frames: U8Frames, fps: float, threshold: float = CUT_THRESHOLD) -> list[int]:
    """Индексы кадров, с которых начинается новый шот (без нуля); шоты короче MIN_SHOT_SEC склеиваются."""
    d = histogram_distances(frames)
    min_gap = max(1, round(MIN_SHOT_SEC * fps))
    cuts: list[int] = []
    for i in np.flatnonzero(d > threshold):
        if i == 0:
            continue
        if cuts and i - cuts[-1] < min_gap:
            if d[i] > d[cuts[-1]]:
                cuts[-1] = int(i)
            continue
        if not cuts and i < min_gap:
            continue
        cuts.append(int(i))
    return cuts


def shots_from_cuts(cuts: list[int], fps: float, duration: float) -> list[tuple[float, float]]:
    """Шоты покрывают [0, duration] без пропусков."""
    bounds = [0.0, *(c / fps for c in cuts), duration]
    return [(a, b) for a, b in pairwise(bounds) if b > a]
