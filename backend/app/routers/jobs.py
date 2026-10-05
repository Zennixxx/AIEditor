from __future__ import annotations

from fastapi import APIRouter, Request

from app.errors import ApiException
from app.jobs.manager import JobManager
from app.models.gen import Job

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _manager(request: Request) -> JobManager:
    return request.app.state.jobs


@router.get("/{job_id}", response_model=Job, response_model_exclude_none=True)
async def get_job(job_id: str, request: Request) -> Job:
    job = _manager(request).get(job_id)
    if job is None:
        raise ApiException(404, "job_not_found", f"Задача {job_id} не найдена")
    return job


@router.delete("/{job_id}", response_model=Job, response_model_exclude_none=True)
async def cancel_job(job_id: str, request: Request) -> Job:
    job = _manager(request).cancel(job_id)
    if job is None:
        raise ApiException(404, "job_not_found", f"Задача {job_id} не найдена")
    return job
