"""Раскладка каталога данных — docs/BACKEND.md «Раскладка данных»."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class DataPaths:
    root: Path

    @property
    def assets(self) -> Path:
        return self.root / "assets"

    @property
    def uploads(self) -> Path:
        return self.root / "uploads"

    @property
    def projects(self) -> Path:
        return self.root / "projects"

    @property
    def gemini_cache(self) -> Path:
        return self.root / "cache" / "gemini"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def presets_file(self) -> Path:
        return self.root / "presets.json"

    def asset_dir(self, asset_id: str) -> Path:
        return self.assets / asset_id

    def analysis_dir(self, asset_id: str) -> Path:
        return self.asset_dir(asset_id) / "analysis"

    def stems_dir(self, asset_id: str) -> Path:
        return self.asset_dir(asset_id) / "stems"

    def ensure(self) -> None:
        for p in (self.assets, self.uploads, self.projects, self.gemini_cache, self.logs):
            p.mkdir(parents=True, exist_ok=True)
