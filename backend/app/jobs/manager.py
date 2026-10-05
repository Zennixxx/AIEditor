"""Фоновые задачи: очередь, статусы, прогресс, отмена — CONTRACT §8 (Job, WsJob).

Задача — корутина `async def fn(ctx: JobContext) -> result`. Тяжёлый CPU-код
внутри неё запускается через `ctx.run_cpu(...)`, внешние процессы — через
asyncio.subprocess (отмена задачи отменяет корутину; процесс нужно убить в finally).
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from concurrent.futures import Executor
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel

from app.jobs.events import EventHub, dump
from app.models.gen import ApiErrorBody, Job, JobKind, WsJob

log = logging.getLogger(__name__)

type Resource = Literal["cpu", "ffmpeg", "rife", "gemini", "light"]
type JobFn = Callable[[JobContext], Awaitable[Any]]

RESOURCE_LIMITS: dict[Resource, int] = {"cpu": 2, "ffmpeg": 2, "rife": 1, "gemini": 4, "light": 8}
PROGRESS_INTERVAL = 0.25  # не чаще 4 событий/с на задачу
MAX_KEPT_JOBS = 500


class JobFailed(Exception):
    """Ожидаемая ошибка задачи с кодом для клиента."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> datetime:
    return datetime.now(UTC)


def new_job_id() -> str:
    return "job_" + secrets.token_hex(5)


class JobContext:
    def __init__(self, manager: JobManager, job_id: str) -> None:
        self._manager = manager
        self.job_id = job_id
        self._last_emit = 0.0

    def progress(self, value: float, message: str | None = None) -> None:
        job = self._manager.get(self.job_id)
        if job is None:
            return
        job.progress = min(max(value, job.progress), 1.0)
        if message is not None:
            job.message = message
        job.updated_at = _now()
        now = time.monotonic()
        if now - self._last_emit >= PROGRESS_INTERVAL:
            self._last_emit = now
            self._manager.emit(job)

    async def run_cpu[T](self, fn: Callable[..., T], *args: Any) -> T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._manager.cpu_executor, fn, *args)


class JobManager:
    def __init__(self, hub: EventHub, cpu_executor: Executor | None = None) -> None:
        self.hub = hub
        self.cpu_executor = cpu_executor
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._sems: dict[Resource, asyncio.Semaphore] = {
            k: asyncio.Semaphore(v) for k, v in RESOURCE_LIMITS.items()
        }

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return list(self._jobs.values())

    def emit(self, job: Job) -> None:
        self.hub.publish(WsJob(type="job", job=job.model_copy()))

    def submit(
        self,
        kind: JobKind,
        fn: JobFn,
        *,
        asset_id: str | None = None,
        resource: Resource = "light",
        message: str | None = None,
    ) -> Job:
        now = _now()
        job = Job(
            id=new_job_id(),
            kind=kind,
            asset_id=asset_id,
            status="queued",
            progress=0.0,
            message=message,
            result=None,
            created_at=now,
            updated_at=now,
        )
        self._jobs[job.id] = job
        self._trim()
        self.emit(job)
        self._tasks[job.id] = asyncio.create_task(self._run(job.id, fn, resource), name=job.id)
        return job

    def cancel(self, job_id: str) -> Job | None:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        task = self._tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()
        elif job.status in ("queued", "running"):
            self._finish(job, "canceled")
        return job

    async def wait(self, job_id: str) -> Job:
        task = self._tasks.get(job_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        job = self._jobs[job_id]
        return job

    async def shutdown(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def _run(self, job_id: str, fn: JobFn, resource: Resource) -> None:
        job = self._jobs[job_id]
        ctx = JobContext(self, job_id)
        try:
            async with self._sems[resource]:
                job.status = "running"
                job.updated_at = _now()
                self.emit(job)
                result = await fn(ctx)
            job.result = dump(result) if isinstance(result, BaseModel) else result
            job.progress = 1.0
            self._finish(job, "done")
        except asyncio.CancelledError:
            self._finish(job, "canceled")
        except JobFailed as exc:
            job.error = ApiErrorBody(code=exc.code, message=exc.message)
            self._finish(job, "failed")
        except Exception as exc:
            log.exception("job %s (%s) failed", job_id, job.kind)
            job.error = ApiErrorBody(code="internal_error", message=f"{type(exc).__name__}: {exc}")
            self._finish(job, "failed")
        finally:
            self._tasks.pop(job_id, None)

    def _finish(self, job: Job, status: Literal["done", "failed", "canceled"]) -> None:
        job.status = status
        job.updated_at = _now()
        self.emit(job)

    def _trim(self) -> None:
        while len(self._jobs) > MAX_KEPT_JOBS:
            oldest_id = next(iter(self._jobs))
            if oldest_id in self._tasks:
                break
            self._jobs.popitem(last=False)
