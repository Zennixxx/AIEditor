"""Темп, доли и даунбиты."""

from __future__ import annotations

import librosa
import numpy as np

from app.audio.bass import F64, HOP, SR


def track_beats(full_env: F64, sr: int = SR) -> tuple[float, F64]:
    tempo, frames = librosa.beat.beat_track(
        onset_envelope=full_env, sr=sr, hop_length=HOP, units="frames", trim=False
    )
    times = librosa.frames_to_time(np.asarray(frames), sr=sr, hop_length=HOP).astype(np.float64)
    bpm = float(np.atleast_1d(tempo)[0])
    if times.size >= 3:
        # темп из медианного интервала точнее сетки librosa (шаг 11.6 мс)
        bpm = 60.0 / float(np.median(np.diff(times)))
    return bpm, times


def snap_to_onsets(beats: F64, onset_times: F64, tolerance: float = 0.035) -> F64:
    """Доли подтягиваем к ближайшему уточнённому онсету: маркер встаёт на реальную атаку."""
    if beats.size == 0 or onset_times.size == 0:
        return beats
    idx = (
        np.clip(np.searchsorted(onset_times, beats), 1, onset_times.size - 1)
        if onset_times.size > 1
        else None
    )
    if idx is None:
        cand = np.full(beats.shape, onset_times[0])
    else:
        left, right = onset_times[idx - 1], onset_times[idx]
        cand = np.where(np.abs(left - beats) <= np.abs(right - beats), left, right)
    out = np.where(np.abs(cand - beats) <= tolerance, cand, beats)
    # порядок и уникальность
    out = np.maximum.accumulate(out)
    return out


def find_downbeats(beats: F64, bass_env: F64, sr: int = SR, period: int = 4) -> F64:
    """Фаза из `period` долей с максимальной суммой силы баса."""
    if beats.size == 0:
        return beats
    if beats.size < period * 2:
        return beats[::period]
    frames = np.clip(np.round(beats * sr / HOP).astype(int), 0, bass_env.size - 1)
    # сила в окне ±2 кадра вокруг доли
    padded = np.pad(bass_env, 2, mode="edge")
    near = np.max(np.stack([padded[frames + k] for k in range(5)]), axis=0)
    scores = [float(near[p::period].mean()) for p in range(period)]
    return beats[int(np.argmax(scores)) :: period]
