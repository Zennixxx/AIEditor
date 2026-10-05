"""RMS-кривая 0..1 с шагом 0.1 с."""

from __future__ import annotations

import librosa
import numpy as np

from app.audio.bass import F32, F64, SR

ENERGY_INTERVAL = 0.1


def energy_curve(y: F32, sr: int = SR, interval: float = ENERGY_INTERVAL) -> F64:
    hop = max(1, round(interval * sr))
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop, center=True)[0].astype(np.float64)
    n = max(1, int(np.ceil(len(y) / hop)))
    rms = rms[:n] if rms.size >= n else np.pad(rms, (0, n - rms.size), mode="edge")
    peak = float(rms.max()) if rms.size else 0.0
    return rms / peak if peak > 1e-9 else np.zeros_like(rms)
