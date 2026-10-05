"""Обёртка над ffmpeg/ffprobe: запуск, прогресс из `-progress pipe:1`, отмена.

Используется subprocess.Popen + потоки, а не asyncio.subprocess: uvicorn с `--reload`
на Windows работает на SelectorEventLoop, где asyncio.subprocess не поддерживается.
Отмена корутины убивает процесс (у ffmpeg нет дочерних процессов, kill достаточно).
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import subprocess
import sys
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import IO, Any

from app.jobs.manager import JobFailed

type ProgressFn = Callable[[float], None]

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
STDERR_TAIL_LINES = 20
PROBE_TIMEOUT = 60


class FfmpegError(JobFailed):
    def __init__(self, message: str) -> None:
        super().__init__("ffmpeg_failed", message)


def popen(cmd: Sequence[str | Path], *, stdout: int | None = subprocess.PIPE) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [str(c) for c in cmd],
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=subprocess.PIPE,
        creationflags=CREATE_NO_WINDOW,
    )


def kill(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is None:
        with contextlib.suppress(OSError):
            proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)


class StderrTail:
    """Читает stderr в фоне (иначе процесс встанет на заполненном пайпе), хранит хвост."""

    def __init__(self, stream: IO[bytes] | None) -> None:
        self._lines: collections.deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)
        self._thread = threading.Thread(target=self._read, args=(stream,), daemon=True)
        self._thread.start()

    def _read(self, stream: IO[bytes] | None) -> None:
        if stream is None:
            return
        for raw in stream:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self._lines.append(line)

    def text(self) -> str:
        self._thread.join(timeout=5)
        return "\n".join(self._lines)


async def wait_process(proc: subprocess.Popen[bytes]) -> int:
    """Дождаться процесса; при отмене корутины — убить его."""
    try:
        return await asyncio.to_thread(proc.wait)
    except BaseException:
        await asyncio.to_thread(kill, proc)
        raise


def _parse_progress(stream: IO[bytes] | None, duration: float, emit: ProgressFn) -> None:
    if stream is None:
        return
    for raw in stream:
        key, _, value = raw.decode("ascii", "replace").strip().partition("=")
        if key == "out_time_us" and duration > 0:
            with contextlib.suppress(ValueError):
                emit(min(max(int(value) / 1e6 / duration, 0.0), 1.0))


async def run_ffmpeg(
    ffmpeg: Path,
    args: Sequence[str | Path],
    *,
    duration: float = 0.0,
    on_progress: ProgressFn | None = None,
) -> None:
    """Запустить ffmpeg; `on_progress(0..1)` вызывается в цикле событий по `out_time_us / duration`."""
    loop = asyncio.get_running_loop()
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
    proc = popen([*cmd, *args])
    err = StderrTail(proc.stderr)

    def emit(value: float) -> None:
        if on_progress is not None:
            loop.call_soon_threadsafe(on_progress, value)

    reader = threading.Thread(target=_parse_progress, args=(proc.stdout, duration, emit), daemon=True)
    reader.start()
    code = await wait_process(proc)
    reader.join(timeout=5)
    if code != 0:
        raise FfmpegError(f"ffmpeg завершился с кодом {code}: {err.text() or 'нет вывода'}")


async def run_ffprobe(ffprobe: Path, path: Path) -> dict[str, Any]:
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]

    def run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=PROBE_TIMEOUT,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )

    res = await asyncio.to_thread(run)
    if res.returncode != 0:
        raise FfmpegError(res.stderr.decode("utf-8", "replace").strip() or f"ffprobe exit {res.returncode}")
    return json.loads(res.stdout.decode("utf-8", "replace") or "{}")
