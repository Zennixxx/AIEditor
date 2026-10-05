"""Реестр эффектов (`shared/effects.json`, CONTRACT §7) и стили (`shared/styles.json`).

При старте реестры проверяются; ошибки не роняют сервер, а уходят в лог и в `/health.registryErrors`.
Те же правила проверяют параметры пользовательских пресетов (`POST /presets`).
"""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.models.gen import EffectDef, EffectParamDef, EffectsRegistry, PresetEffect, StylesFile
from app.storage.atomic import read_json

log = logging.getLogger(__name__)

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")


@dataclass(slots=True)
class Registry:
    effects: dict[str, EffectDef] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    def param_errors(self, effect_id: str, params: Mapping[str, Any], where: str) -> list[str]:
        """Ошибки параметров эффекта по реестру; неизвестный эффект — одна ошибка."""
        definition = self.effects.get(effect_id)
        if definition is None:
            return [f"{where}: неизвестный эффект {effect_id!r}"]
        defs = {p.key: p for p in definition.params}
        errors: list[str] = []
        for key, value in params.items():
            p = defs.get(key)
            if p is None:
                errors.append(f"{where}: у эффекта {effect_id} нет параметра {key!r}")
                continue
            err = value_error(p, value)
            if err:
                errors.append(f"{where}: {effect_id}.{key} {err}")
        return errors

    def preset_errors(self, effects: Iterable[PresetEffect]) -> list[str]:
        errors: list[str] = []
        for i, fx in enumerate(effects):
            errors += self.param_errors(fx.effect, fx.params, f"effects[{i}]")
        return errors


def value_error(p: EffectParamDef, value: Any) -> str | None:
    """Почему значение не подходит параметру (None — подходит)."""
    match p.type:
        case "number":
            if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
                return f"= {value!r}: ожидается число"
            if (p.min is not None and value < p.min) or (p.max is not None and value > p.max):
                return f"= {value!r} вне диапазона {p.min}..{p.max}"
        case "boolean":
            if not isinstance(value, bool):
                return f"= {value!r}: ожидается boolean"
        case "color":
            if not isinstance(value, str) or not COLOR_RE.match(value):
                return f"= {value!r}: ожидается цвет #rrggbb или #rrggbbaa"
        case "enum":
            if value not in (p.options or []):
                return f"= {value!r}: допустимо {p.options}"
    return None


def _check_effects(reg: EffectsRegistry) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for e in reg.effects:
        if e.id in seen:
            errors.append(f"effects.json: повторяется id {e.id!r}")
        seen.add(e.id)
        keys: set[str] = set()
        for p in e.params:
            where = f"effects.json: {e.id}.{p.key}"
            if p.key in keys:
                errors.append(f"{where}: повторяется ключ")
            keys.add(p.key)
            if p.type == "number" and p.min is not None and p.max is not None and p.min > p.max:
                errors.append(f"{where}: min > max")
            if p.type == "enum" and not p.options:
                errors.append(f"{where}: у enum нет options")
            err = value_error(p, p.default)
            if err:
                errors.append(f"{where}: default {err}")
    return errors


def _check_styles(styles: StylesFile, registry: Registry) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for s in styles.styles:
        if s.id in seen:
            errors.append(f"styles.json: повторяется id {s.id!r}")
        seen.add(s.id)
        rules = [(r.effect, r.params) for r in s.effects] + [
            (g.effect, g.params) for g in s.global_effects or []
        ]
        for effect, params in rules:
            errors += registry.param_errors(effect, params, f"styles.json: {s.id}")
        for t in s.transitions:
            errors += registry.param_errors(t.effect, {}, f"styles.json: {s.id}")
    return errors


def _load(path: Path, model: type[EffectsRegistry] | type[StylesFile]) -> tuple[Any, list[str]]:
    try:
        return model.model_validate(read_json(path)), []
    except FileNotFoundError:
        return None, [f"{path.name}: файл не найден"]
    except ValueError as exc:  # JSONDecodeError и ValidationError — оба ValueError
        if isinstance(exc, ValidationError):
            msgs = [f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()[:10]]
            return None, [f"{path.name}: {m}" for m in msgs]
        return None, [f"{path.name}: некорректный JSON ({exc})"]


def load_registry(shared_dir: Path) -> Registry:
    registry = Registry()
    effects, errors = _load(shared_dir / "effects.json", EffectsRegistry)
    registry.errors += errors
    if effects is not None:
        registry.effects = {e.id: e for e in effects.effects}
        registry.errors += _check_effects(effects)
        styles, errors = _load(shared_dir / "styles.json", StylesFile)
        registry.errors += errors
        if styles is not None:
            registry.errors += _check_styles(styles, registry)
    for err in registry.errors:
        log.error("Реестр: %s", err)
    return registry
