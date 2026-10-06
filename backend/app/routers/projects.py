"""CRUD проектов — CONTRACT §8–9."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.errors import ApiException
from app.models.gen import CreateProjectRequest, Project, ProjectListItem
from app.storage.projects_repo import ProjectNotFound, ProjectsRepo, RevisionConflict

router = APIRouter(prefix="/projects", tags=["projects"])


def _repo(request: Request) -> ProjectsRepo:
    return request.app.state.projects


def _not_found(project_id: str) -> ApiException:
    return ApiException(404, "project_not_found", f"Проект {project_id} не найден")


@router.get("", response_model=list[ProjectListItem], response_model_exclude_none=True)
async def list_projects(request: Request) -> list[ProjectListItem]:
    return _repo(request).list()


@router.post("", response_model=Project, response_model_exclude_none=True)
async def create_project(body: CreateProjectRequest, request: Request) -> Project:
    return _repo(request).create(body)


@router.get("/{project_id}", response_model=Project, response_model_exclude_none=True)
async def get_project(project_id: str, request: Request) -> Project:
    try:
        return _repo(request).get(project_id)
    except ProjectNotFound as exc:
        raise _not_found(project_id) from exc


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, request: Request) -> Response:
    try:
        _repo(request).delete(project_id)
    except ProjectNotFound as exc:
        raise _not_found(project_id) from exc
    return Response(status_code=204)


@router.put("/{project_id}", response_model=Project, response_model_exclude_none=True)
async def save_project(project_id: str, body: Project, request: Request) -> Project:
    if body.id != project_id:
        raise ApiException(400, "project_id_mismatch", "id в теле не совпадает с id в пути", {"id": body.id})
    try:
        return _repo(request).save(body)
    except ProjectNotFound as exc:
        raise _not_found(project_id) from exc
    except RevisionConflict as exc:
        raise ApiException(
            409,
            "revision_conflict",
            "Проект изменён в другом окне",
            {"revision": exc.current},
        ) from exc
