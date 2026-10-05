"""Зависимости задач и отмена ffmpeg."""

from __future__ import annotations

import asyncio
import time

import pytest

from app.jobs.events import EventHub
from app.jobs.manager import JobContext, JobManager
from app.media.ffmpeg import FfmpegError, run_ffmpeg
from tests.conftest import FFMPEG, requires_ffmpeg


async def test_depends_on_waits_without_holding_slot() -> None:
    manager = JobManager(EventHub())
    order: list[str] = []
    gate = asyncio.Event()

    async def first(_: JobContext) -> str:
        await gate.wait()
        order.append("first")
        return "a"

    async def second(_: JobContext) -> str:
        order.append("second")
        return "b"

    a = manager.submit("debug", first, resource="ffmpeg")
    b = manager.submit("debug", second, resource="ffmpeg", depends_on=[a.id])
    c = manager.submit("debug", second, resource="ffmpeg")  # второй слот ffmpeg свободен
    await manager.wait(c.id)
    assert manager.get(b.id).status == "queued"  # type: ignore[union-attr]
    gate.set()
    await manager.wait(b.id)
    assert order == ["second", "first", "second"]

    # отмена ожидающей задачи не трогает ту, от которой она зависит
    gate.clear()
    d = manager.submit("debug", first)
    e = manager.submit("debug", second, depends_on=[d.id])
    await asyncio.sleep(0.01)
    manager.cancel(e.id)
    await manager.wait(e.id)
    assert manager.get(e.id).status == "canceled"  # type: ignore[union-attr]
    assert manager.get(d.id).status == "running"  # type: ignore[union-attr]
    gate.set()
    await manager.wait(d.id)
    assert manager.get(d.id).status == "done"  # type: ignore[union-attr]


@requires_ffmpeg
async def test_cancel_kills_ffmpeg() -> None:
    assert FFMPEG is not None
    progress: list[float] = []
    task = asyncio.create_task(
        run_ffmpeg(
            FFMPEG,
            ["-re", "-f", "lavfi", "-i", "testsrc=duration=60:size=320x240:rate=30", "-f", "null", "-"],
            duration=60,
            on_progress=progress.append,
        )
    )
    await asyncio.sleep(1.5)
    t0 = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - t0 < 5
    assert progress and 0 < progress[-1] < 0.2


@requires_ffmpeg
async def test_ffmpeg_error_is_reported() -> None:
    assert FFMPEG is not None
    with pytest.raises(FfmpegError) as exc:
        await run_ffmpeg(FFMPEG, ["-i", "definitely_missing_file.mp4", "-f", "null", "-"])
    assert exc.value.code == "ffmpeg_failed"
    assert "definitely_missing_file" in exc.value.message
