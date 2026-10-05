"""Секции трека: самоподобие chroma+MFCC → границы по даунбитам → метки по энергии."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise

import librosa
import numpy as np

from app.audio.bass import F32, F64, SR

FEATURE_HOP = 2048
MIN_SECTION_SEC = 4.0
ENERGY_WEIGHT = 2.5  # громкость — главный признак для монтажа, весим её выше тембра


@dataclass(frozen=True, slots=True)
class Span:
    start: float
    end: float
    label: str
    energy: float


def target_k(duration: float) -> int:
    return int(np.clip(round(duration / 30.0), 3, 10))


def _standardise(x: F64) -> F64:
    mu = x.mean(axis=1, keepdims=True)
    sd = x.std(axis=1, keepdims=True)
    return (x - mu) / np.where(sd < 1e-9, 1.0, sd)


def boundary_candidates(y: F32, beats: F64, duration: float, sr: int = SR) -> F64:
    """Времена границ (внутренних), k по длине трека. Признаки синхронизированы по долям."""
    k = target_k(duration)
    n_frames = 1 + len(y) // FEATURE_HOP
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=FEATURE_HOP, n_fft=4096)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=FEATURE_HOP, n_mfcc=13, n_fft=4096)[1:]
    rms = librosa.feature.rms(y=y, frame_length=4096, hop_length=FEATURE_HOP)
    loud = np.log1p(100.0 * rms / (rms.max() + 1e-9))
    m = min(chroma.shape[1], mfcc.shape[1], loud.shape[1], n_frames)

    beat_frames = np.unique(np.clip(librosa.time_to_frames(beats, sr=sr, hop_length=FEATURE_HOP), 0, m - 1))
    if beat_frames.size < k * 2:  # доли не найдены — делим равномерной сеткой
        beat_frames = np.linspace(0, m - 1, num=max(k * 4, 16)).astype(int)
        beat_frames = np.unique(beat_frames)
    parts = [chroma[:, :m], mfcc[:, :m], loud[:, :m]]
    synced = [librosa.util.sync(p, beat_frames.tolist(), aggregate=np.mean) for p in parts]
    timbre = np.vstack([_standardise(synced[0]), _standardise(synced[1])])
    loudness = ENERGY_WEIGHT * _standardise(synced[2])
    n = timbre.shape[1]
    if n < k + 1:
        return np.zeros(0)

    # повторы: сглаживаем тембр соседями по самоподобию (repetition-aware smoothing);
    # громкость не сглаживаем — повторяющаяся «тихая» часть в начале и конце всё равно разные секции
    rec = librosa.segment.recurrence_matrix(
        timbre, mode="affinity", metric="cosine", sym=True, k=min(max(2, n // 8), n - 1)
    )
    smooth = librosa.decompose.nn_filter(timbre, rec=rec, aggregate=np.median, axis=-1)
    smooth = np.vstack([0.5 * timbre + 0.5 * smooth, loudness])
    bounds = librosa.segment.agglomerative(smooth, k)  # индексы сегментов в синхр. кадрах, [0] = 0

    # sync: сегмент i начинается на кадре beat_frames[i-1] (нулевой — до первой доли)
    starts = np.unique(np.concatenate([[0], beat_frames]))
    inner = [int(starts[b]) for b in bounds if 0 < b < starts.size]
    return librosa.frames_to_time(np.asarray(inner), sr=sr, hop_length=FEATURE_HOP).astype(np.float64)


def align_boundaries(
    cands: F64, downbeats: F64, duration: float, min_len: float = MIN_SECTION_SEC
) -> list[float]:
    """Выровнять к ближайшему даунбиту, убрать дубли и слишком короткие секции."""
    pts: list[float] = []
    for c in sorted(float(x) for x in cands):
        t = float(downbeats[int(np.argmin(np.abs(downbeats - c)))]) if downbeats.size else c
        pts.append(t)
    inner: list[float] = []
    last = 0.0
    for t in sorted(set(pts)):
        if t - last >= min_len and duration - t >= min_len:
            inner.append(t)
            last = t
    return inner


def span_energy(energy: F64, interval: float, start: float, end: float) -> float:
    a = int(start / interval)
    b = max(a + 1, int(np.ceil(end / interval)))
    return float(np.clip(energy[a:b].mean(), 0.0, 1.0)) if energy.size > a else 0.0


def label_sections(energies: list[float], spans_inner_energy: list[tuple[float, float]]) -> list[str]:
    """Метки по энергии: drop > intro(первая) > outro(последняя) > build > break > verse.

    `spans_inner_energy` — (энергия первой половины, энергия второй) каждой секции.
    """
    n = len(energies)
    if n == 0:
        return []
    hi, lo = max(energies), min(energies)
    labels = ["verse"] * n
    contrast = hi - lo >= 0.12
    is_drop = [contrast and e >= 0.85 * hi and e >= 0.45 for e in energies]
    for i in range(n):
        if is_drop[i]:
            labels[i] = "drop"
        elif n > 1 and i == 0:
            labels[i] = "intro"
        elif n > 1 and i == n - 1:
            labels[i] = "outro"
        elif (
            i + 1 < n
            and is_drop[i + 1]
            and energies[i] < energies[i + 1]
            and (spans_inner_energy[i][1] > spans_inner_energy[i][0] * 1.08)
        ):
            labels[i] = "build"
        elif contrast and energies[i] <= 0.5 * hi:
            labels[i] = "break"
    return labels


MERGE_ENERGY_DELTA = 0.06


def merge_similar(edges: list[float], energy: F64, interval: float) -> list[float]:
    """Соседние секции с почти одинаковой энергией — одна секция (граница не несёт смысла для монтажа)."""
    edges = list(edges)
    while len(edges) > 2:
        e = [span_energy(energy, interval, a, b) for a, b in pairwise(edges)]
        diffs = [abs(x - y) for x, y in pairwise(e)]
        i = int(np.argmin(diffs))
        if diffs[i] >= MERGE_ENERGY_DELTA:
            break
        del edges[i + 1]
    return edges


def build_sections(
    y: F32, beats: F64, downbeats: F64, energy: F64, interval: float, duration: float, sr: int = SR
) -> list[Span]:
    cands = boundary_candidates(y, beats, duration, sr)
    edges = merge_similar([0.0, *align_boundaries(cands, downbeats, duration), duration], energy, interval)
    energies: list[float] = []
    halves: list[tuple[float, float]] = []
    for a, b in pairwise(edges):
        mid = (a + b) / 2
        energies.append(span_energy(energy, interval, a, b))
        halves.append((span_energy(energy, interval, a, mid), span_energy(energy, interval, mid, b)))
    labels = label_sections(energies, halves)
    return [
        Span(round(a, 4), round(b, 4), lab, round(e, 3))
        for (a, b), lab, e in zip(pairwise(edges), labels, energies, strict=True)
    ]
