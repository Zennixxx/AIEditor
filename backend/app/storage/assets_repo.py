"""Хранилище ассетов: data/assets/{id}/meta.json + кэш в памяти."""

from __future__ import annotations

import logging

from app.jobs.events import dump
from app.models.gen import Asset
from app.storage import atomic
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)


class AssetsRepo:
    def __init__(self, paths: DataPaths) -> None:
        self.paths = paths
        self._cache: dict[str, Asset] = {}

    def load_all(self) -> None:
        self._cache.clear()
        if not self.paths.assets.is_dir():
            return
        metas = sorted(self.paths.assets.glob("*/meta.json"), key=lambda p: p.stat().st_mtime)
        for meta in metas:
            try:
                asset = Asset.model_validate(atomic.read_json(meta))
            except Exception:
                log.exception("broken asset meta %s, skipped", meta)
                continue
            self._cache[asset.id] = asset

    def get(self, asset_id: str) -> Asset | None:
        return self._cache.get(asset_id)

    def list(self) -> list[Asset]:
        return list(self._cache.values())

    def forget(self, asset_id: str) -> None:
        self._cache.pop(asset_id, None)

    def save(self, asset: Asset) -> None:
        atomic.write_json(self.paths.asset_dir(asset.id) / "meta.json", dump(asset))
        self._cache[asset.id] = asset
