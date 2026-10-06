"""Пользовательские пресеты: data/presets.json = {version, presets, styles?} — CONTRACT §8."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from app.ids import new_id
from app.jobs.events import dump
from app.models.gen import CreateEffectPresetRequest, EffectPreset, StylePreset
from app.storage import atomic
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)

FILE_VERSION = 1


class PresetsRepo:
    def __init__(self, paths: DataPaths) -> None:
        self.paths = paths
        self._lock = threading.Lock()

    def _read(self) -> tuple[dict[str, Any], list[EffectPreset]]:
        """Содержимое файла (прочие ключи сохраняются при записи) и пресеты.

        Файла нет → пусто. Битый файл откладывается в сторону, чтобы следующая запись его не затёрла.
        """
        path = self.paths.presets_file
        try:
            raw = atomic.read_json(path)
            presets = [EffectPreset.model_validate(p) for p in raw["presets"]]
            return raw, presets
        except FileNotFoundError:
            return {}, []
        except (ValueError, KeyError, TypeError) as exc:
            if isinstance(exc, ValidationError):
                exc = ValueError(f"{exc.error_count()} ошибок валидации")
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
            broken = path.with_name(f"{path.stem}.broken-{stamp}{path.suffix}")
            log.error("%s повреждён (%s), перенесён в %s", path.name, exc, broken.name)
            atomic.replace(path, broken)
            return {}, []

    def list(self) -> list[EffectPreset]:
        with self._lock:
            return self._read()[1]

    def create(self, body: CreateEffectPresetRequest) -> EffectPreset:
        preset = EffectPreset(
            id=new_id("pst"), name=body.name, description=body.description, effects=body.effects
        )
        with self._lock:
            raw, presets = self._read()
            presets.append(preset)
            atomic.write_json(
                self.paths.presets_file,
                {**raw, "version": FILE_VERSION, "presets": [dump(p) for p in presets]},
            )
        return preset

    def list_styles(self) -> list[StylePreset]:
        with self._lock:
            raw = self._read()[0]
        styles: list[StylePreset] = []
        for item in raw.get("styles", []):
            try:
                styles.append(StylePreset.model_validate(item))
            except ValidationError:
                log.warning("Пользовательский стиль пропущен: не по схеме")
        return styles

    def save_style(self, style: StylePreset) -> None:
        """Добавить стиль или заменить стиль с тем же id."""
        with self._lock:
            raw, presets = self._read()
            styles = [
                s for s in raw.get("styles", []) if not (isinstance(s, dict) and s.get("id") == style.id)
            ]
            styles.append(dump(style))
            atomic.write_json(
                self.paths.presets_file,
                {**raw, "version": FILE_VERSION, "presets": [dump(p) for p in presets], "styles": styles},
            )
