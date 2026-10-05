"""Разделение на стемы — Demucs htdemucs (только с extra `[stems]`)."""

from __future__ import annotations

import asyncio
import importlib.util
import shutil
import sys
import tempfile
from pathlib import Path

from app.errors import ApiException
from app.jobs.manager import JobContext, JobFailed
from app.media.ffmpeg import StderrTail, popen, wait_process
from app.storage import atomic

STEM_NAMES = ("drums", "bass", "other", "vocals")
MODEL = "htdemucs"


def demucs_installed() -> bool:
    return importlib.util.find_spec("demucs") is not None


def require_demucs() -> None:
    if not demucs_installed():
        raise ApiException(
            501,
            "demucs_not_installed",
            "Demucs не установлен: выполните `uv sync --extra stems` в backend/",
        )


def stem_path(stems_dir: Path, name: str) -> Path:
    return stems_dir / f"{name}.wav"


def stems_ready(stems_dir: Path) -> bool:
    return all(stem_path(stems_dir, n).is_file() for n in STEM_NAMES)


def device_warning() -> str | None:
    """На CPU htdemucs идёт в несколько раз дольше длительности трека — предупреждаем в `message`."""
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            return None
    except Exception:  # torch нет или сломан — считаем, что GPU нет
        pass
    return "Demucs на CPU: разделение может занять в несколько раз больше длительности трека"


async def separate(ctx: JobContext, ffmpeg: Path, src: Path, stems_dir: Path) -> None:
    """src → wav 44.1 кГц → `python -m demucs` → stems/*.wav. Отмена убивает процесс."""
    if stems_ready(stems_dir):
        return
    stems_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="stems-", dir=stems_dir.parent) as tmp_s:
        tmp = Path(tmp_s)
        wav = tmp / "in.wav"
        ctx.progress(0.02, device_warning() or "Подготовка аудио для Demucs")
        conv = popen([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", src, "-vn",
                      "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav])  # fmt: skip
        err = StderrTail(conv.stderr)
        if await wait_process(conv) != 0:
            raise JobFailed("ffmpeg_failed", f"ffmpeg (stems) не смог подготовить аудио: {err.text()}")
        ctx.progress(0.1)
        proc = popen([sys.executable, "-m", "demucs", "-n", MODEL, "-o", tmp / "out", wav])
        dem_err = StderrTail(proc.stderr)
        if await wait_process(proc) != 0:
            raise JobFailed("stems_failed", f"Demucs завершился с ошибкой: {dem_err.text()}")
        out = tmp / "out" / MODEL / "in"
        ctx.progress(0.95)
        stage = tmp / "stems"
        stage.mkdir()
        for name in STEM_NAMES:
            f = out / f"{name}.wav"
            if not f.is_file():
                raise JobFailed("stems_failed", f"Demucs не создал {name}.wav")
            shutil.move(f, stage / f.name)
        await asyncio.to_thread(atomic.replace_dir, stage, stems_dir)


def mix_rhythm_stems(ffmpeg: Path, stems_dir: Path, dst: Path) -> Path:
    """drums + bass → один wav для детектора (синхронно, вызывается в рабочем потоке)."""
    import subprocess

    cmd = [str(ffmpeg), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
           "-i", str(stem_path(stems_dir, "drums")), "-i", str(stem_path(stems_dir, "bass")),
           "-filter_complex", "amix=inputs=2:normalize=0", str(dst)]  # fmt: skip
    subprocess.run(cmd, check=True, capture_output=True)
    return dst
