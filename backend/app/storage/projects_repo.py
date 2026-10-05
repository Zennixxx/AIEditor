"""Проекты: data/projects/{id}.json + история {id}.history/{revision}.json — CONTRACT §9."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from pathlib import Path

from app.ids import PROJECT_ID_RE, new_id
from app.jobs.events import dump
from app.models.gen import CreateProjectRequest, Project, ProjectListItem
from app.storage import atomic
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)

HISTORY_LIMIT = 20
DEFAULT_BACKGROUND = "#000000"


class ProjectNotFound(Exception):
    def __init__(self, project_id: str) -> None:
        super().__init__(project_id)
        self.project_id = project_id


class RevisionConflict(Exception):
    def __init__(self, current: int) -> None:
        super().__init__(current)
        self.current = current


def _now() -> datetime:
    return datetime.now(UTC)


class ProjectsRepo:
    def __init__(self, paths: DataPaths, history_limit: int = HISTORY_LIMIT) -> None:
        self.paths = paths
        self.history_limit = history_limit
        self._lock = threading.Lock()

    def _file(self, project_id: str) -> Path:
        if not PROJECT_ID_RE.match(project_id):
            raise ProjectNotFound(project_id)
        return self.paths.projects / f"{project_id}.json"

    def history_dir(self, project_id: str) -> Path:
        return self.paths.projects / f"{project_id}.history"

    def _write(self, project: Project) -> None:
        atomic.write_json(self._file(project.id), dump(project))

    def list(self) -> list[ProjectListItem]:
        items: list[ProjectListItem] = []
        for f in self.paths.projects.glob("prj_*.json"):
            try:
                p = Project.model_validate(atomic.read_json(f))
            except Exception:
                log.exception("broken project file %s, skipped", f)
                continue
            items.append(ProjectListItem(id=p.id, name=p.name, updated_at=p.updated_at))
        items.sort(key=lambda i: i.updated_at, reverse=True)
        return items

    def get(self, project_id: str) -> Project:
        f = self._file(project_id)
        if not f.is_file():
            raise ProjectNotFound(project_id)
        return Project.model_validate(atomic.read_json(f))

    def create(self, req: CreateProjectRequest) -> Project:
        now = _now()
        with self._lock:
            while True:
                project_id = new_id("prj")
                if not self._file(project_id).exists():
                    break
            project = Project(
                schema_version=1,
                id=project_id,
                name=req.name,
                fps=req.fps,
                width=req.width,
                height=req.height,
                duration=0.0,
                background=DEFAULT_BACKGROUND,
                assets=[],
                tracks=[],
                markers=[],
                sections=[],
                created_at=now,
                updated_at=now,
                revision=0,
            )
            self._write(project)
        return project

    def save(self, project: Project) -> Project:
        """Сохранить с оптимистичной блокировкой: `project.revision` должен совпасть с текущим."""
        with self._lock:
            current = self.get(project.id)
            if project.revision != current.revision:
                raise RevisionConflict(current.revision)
            hist = self.history_dir(project.id)
            atomic.write_json(hist / f"{current.revision}.json", dump(current))
            saved = project.model_copy(
                update={
                    "revision": current.revision + 1,
                    "updated_at": _now(),
                    "created_at": current.created_at,
                }
            )
            self._write(saved)
            self._trim_history(hist)
        return saved

    def _trim_history(self, hist: Path) -> None:
        versions = sorted(
            (f for f in hist.glob("*.json") if f.stem.isdigit()), key=lambda f: int(f.stem), reverse=True
        )
        for old in versions[self.history_limit :]:
            old.unlink(missing_ok=True)
