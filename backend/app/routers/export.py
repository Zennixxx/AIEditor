from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.export.ae_jsx import build_ae_jsx, content_disposition
from app.models.gen import Project

router = APIRouter(prefix="/export", tags=["export"])


@router.post("/ae-jsx")
async def export_ae_jsx(project: Project, request: Request) -> Response:
    script = build_ae_jsx(project, request.app.state.registry)
    return Response(
        content=script.encode("utf-8"),
        media_type="text/javascript; charset=utf-8",
        headers={"Content-Disposition": content_disposition(f"{project.name}.jsx")},
    )
