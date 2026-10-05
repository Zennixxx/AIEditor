"""Полный DSP-анализ файла — выполняется в рабочем процессе (ProcessPoolExecutor).

Всё, что принимает и возвращает `analyze_file`, — простые picklable-типы.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np

from app.audio.bass import F32, SR, detect_bass, detect_broadband
from app.audio.beats import find_downbeats, snap_to_onsets, track_beats
from app.audio.energy import ENERGY_INTERVAL, energy_curve
from app.audio.sections import build_sections

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


class AudioDecodeError(RuntimeError):
    pass


def load_mono(ffmpeg: Path, src: Path, sr: int = SR) -> F32:
    """ffmpeg → моно float32 sr Гц (m4a/mp3/видео — всё, что читает ffmpeg)."""
    cmd = [str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(src), "-vn", "-sn",
           "-dn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "pipe:1"]  # fmt: skip
    proc = subprocess.run(cmd, capture_output=True, creationflags=CREATE_NO_WINDOW)
    if proc.returncode != 0:
        raise AudioDecodeError(proc.stderr.decode("utf-8", "replace").strip()[-400:] or "ffmpeg failed")
    y = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)
    if y.size < sr // 2:
        raise AudioDecodeError("слишком короткое или пустое аудио")
    return y


def _round(a: Any, n: int) -> list[float]:
    return [round(float(x), n) for x in a]


def analyze_signal(
    y: F32, params: dict[str, Any], y_rhythm: F32 | None = None, sr: int = SR
) -> dict[str, Any]:
    """`y` — полный микс (энергия, секции), `y_rhythm` — вход баса/онсетов (стем drums+bass или `y`).

    Возвращает словарь в camelCase-форме `MusicAnalysis` без `assetId`/`params`/`stems`.
    """
    sens, gap = float(params["sensitivity"]), float(params["minGapSec"])
    duration = len(y) / sr
    yr = y if y_rhythm is None else y_rhythm

    bass, bass_env = detect_bass(yr, sr, float(params["bassCutoffHz"]), sens, gap)
    onsets, full_env = detect_broadband(yr, sr, sens, gap)
    bpm, beats = track_beats(full_env, sr)
    beats = snap_to_onsets(beats, onsets.times)
    downbeats = find_downbeats(beats, bass_env, sr)
    energy = energy_curve(y, sr)
    sections = build_sections(y, beats, downbeats, energy, ENERGY_INTERVAL, duration, sr)

    def timed(o: Any) -> list[dict[str, float]]:
        return [
            {"t": round(float(t), 4), "strength": round(float(s), 3)}
            for t, s in zip(o.times, o.strength, strict=True)
        ]

    return {
        "bpm": round(bpm, 2),
        "beats": _round(beats, 4),
        "downbeats": _round(downbeats, 4),
        "bass": timed(bass),
        "onsets": timed(onsets),
        "sections": [
            {"start": s.start, "end": s.end, "label": s.label, "energy": s.energy} for s in sections
        ],
        "energy": {"interval": ENERGY_INTERVAL, "values": _round(energy, 3)},
    }


def analyze_file(
    ffmpeg: str, src: str, params: dict[str, Any], rhythm_src: str | None = None
) -> dict[str, Any]:
    y = load_mono(Path(ffmpeg), Path(src))
    yr = load_mono(Path(ffmpeg), Path(rhythm_src)) if rhythm_src else None
    return analyze_signal(y, params, yr)
