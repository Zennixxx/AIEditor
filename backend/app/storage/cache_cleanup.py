"""Очистка кэша — CONTRACT §8.8: неиспользуемые ассеты и старые ответы Gemini."""

from __future__ import annotations

import contextlib
import logging
import shutil
import time
from collections.abc import Iterable
from pathlib import Path

from app.jobs.manager import JobManager
from app.models.gen import Asset, CacheCleanupResult, Clip, Project
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths
from app.storage.projects_repo import ProjectsRepo

log = logging.getLogger(__name__)

DAY = 86_400.0
GEMINI_FILES_INDEX = "files.json"


def used_asset_ids(projects: Iterable[Project]) -> set[str]:
    used: set[str] = set()
    for p in projects:
        used.update(a.id for a in p.assets)
        for track in p.tracks:
            for item in track.items:
                if isinstance(item, Clip):
                    used.add(item.asset_id)
                    if item.interpolated_asset_id:
                        used.add(item.interpolated_asset_id)
    return used


def _files(folder: Path) -> list[Path]:
    with contextlib.suppress(OSError):
        return [f for f in folder.rglob("*") if f.is_file()]
    return []


def _size(files: Iterable[Path]) -> int:
    total = 0
    for f in files:
        with contextlib.suppress(OSError):
            total += f.stat().st_size
    return total


def _last_change(files: Iterable[Path]) -> float:
    latest = 0.0
    for f in files:
        with contextlib.suppress(OSError):
            latest = max(latest, f.stat().st_mtime)
    return latest


def _upload_dir(asset: Asset, uploads: Path) -> Path | None:
    path = Path(asset.path)
    with contextlib.suppress(ValueError):
        rel = path.resolve().relative_to(uploads.resolve())
        if len(rel.parts) == 2:
            return uploads / rel.parts[0]
    return None


def _remove_tree(folder: Path) -> bool:
    for _ in range(10):
        shutil.rmtree(folder, ignore_errors=True)
        if not folder.exists():
            return True
        time.sleep(0.05)
    log.warning("cache cleanup: cannot fully remove %s", folder)
    return False


class CacheCleaner:
    def __init__(
        self, paths: DataPaths, assets: AssetsRepo, projects: ProjectsRepo, jobs: JobManager
    ) -> None:
        self.paths = paths
        self.assets = assets
        self.projects = projects
        self.jobs = jobs

    def _saved_projects(self) -> list[Project]:
        out: list[Project] = []
        for item in self.projects.list():
            with contextlib.suppress(Exception):
                out.append(self.projects.get(item.id))
        return out

    def _busy_assets(self) -> set[str]:
        return {j.asset_id for j in self.jobs.list() if j.asset_id and j.status in ("queued", "running")}

    def run(self, older_than_days: int, now: float | None = None) -> CacheCleanupResult:
        cutoff = (time.time() if now is None else now) - older_than_days * DAY
        used = used_asset_ids(self._saved_projects())
        busy = self._busy_assets()
        removed: list[str] = []
        freed = 0
        for asset in self.assets.list():
            if asset.id in used or asset.id in busy or asset.status == "importing":
                continue
            if asset.parent and asset.parent.asset_id in busy:
                continue
            folder = self.paths.asset_dir(asset.id)
            files = _files(folder)
            upload = _upload_dir(asset, self.paths.uploads)
            upload_files = _files(upload) if upload else []
            if _last_change(files) > cutoff:
                continue
            size = _size(files) + _size(upload_files)
            if not _remove_tree(folder) and (folder / "meta.json").exists():
                continue
            self.assets.forget(asset.id)
            if upload and not any(a.path == asset.path for a in self.assets.list()):
                _remove_tree(upload)
            removed.append(asset.id)
            freed += size - _size(_files(folder))
        gemini_files, gemini_bytes = self._clean_gemini(cutoff)
        log.info(
            "cache cleanup (older than %s d): %d assets, %d gemini files, %d bytes",
            older_than_days,
            len(removed),
            gemini_files,
            freed + gemini_bytes,
        )
        return CacheCleanupResult(
            removed_assets=removed, gemini_files=gemini_files, freed_bytes=freed + gemini_bytes
        )

    def _clean_gemini(self, cutoff: float) -> tuple[int, int]:
        count = freed = 0
        folder = self.paths.gemini_cache
        if not folder.is_dir():
            return 0, 0
        for f in folder.glob("*.json"):
            if f.name == GEMINI_FILES_INDEX:
                continue
            try:
                st = f.stat()
                if st.st_mtime > cutoff:
                    continue
                f.unlink()
            except OSError:
                continue
            count += 1
            freed += st.st_size
        return count, freed
