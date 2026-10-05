"""Отладочные эндпоинты, включаются AIEDITOR_DEBUG=1."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.jobs.manager import JobContext, JobManager
from app.models.gen import JobRef

router = APIRouter(prefix="/debug", tags=["debug"])


class SleepJobRequest(BaseModel):
    seconds: float = Field(1.0, ge=0, le=60)
    steps: int = Field(10, ge=1, le=1000)


@router.post("/sleep-job", response_model=JobRef)
async def sleep_job(body: SleepJobRequest, request: Request) -> JobRef:
    manager: JobManager = request.app.state.jobs

    async def run(ctx: JobContext) -> dict[str, int]:
        for i in range(body.steps):
            await asyncio.sleep(body.seconds / body.steps)
            ctx.progress((i + 1) / body.steps, f"шаг {i + 1}/{body.steps}")
        return {"steps": body.steps}

    job = manager.submit("debug", run, message="sleep")
    return JobRef(job_id=job.id)
