"""Пресеты эффектов и проверка реестров — BACKEND.md фаза 4."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.effects.registry import load_registry
from app.main import create_app
from tests.conftest import FIXTURES, SHARED, load_json

ENV = {"attack": 0, "hold": 0.05, "decay": 0.3, "curve": "exp"}


def preset_body(**params: Any) -> dict[str, Any]:
    return {
        "name": "Удар",
        "effects": [{"effect": "shake", "start": 0, "duration": 0.35, "params": params, "envelope": ENV}],
    }


def test_presets_empty_without_file(client: TestClient) -> None:
    r = client.get("/api/presets")
    assert r.status_code == 200
    assert r.json() == []


def test_create_and_list_presets(client: TestClient, settings: Settings) -> None:
    created = []
    for body in [preset_body(amount=60, motionBlur=False), *load_json(FIXTURES / "presets.json")]:
        body = {k: v for k, v in body.items() if k != "id"}
        r = client.post("/api/presets", json=body)
        assert r.status_code == 200, r.text
        p = r.json()
        assert p["id"].startswith("pst_")
        assert p["name"] == body["name"] and p["effects"] == body["effects"]
        created.append(p)
    assert len({p["id"] for p in created}) == len(created)
    assert client.get("/api/presets").json() == created

    raw = json.loads((settings.data_dir / "presets.json").read_text(encoding="utf-8"))
    assert raw["version"] == 1
    assert raw["presets"] == created


def test_create_preserves_other_keys(client: TestClient, settings: Settings) -> None:
    path = settings.data_dir / "presets.json"
    path.write_text(json.dumps({"version": 1, "presets": [], "styles": [{"id": "mine"}]}), encoding="utf-8")
    assert client.post("/api/presets", json=preset_body()).status_code == 200
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["styles"] == [{"id": "mine"}] and len(raw["presets"]) == 1


def test_broken_file_is_moved_aside(client: TestClient, settings: Settings) -> None:
    path = settings.data_dir / "presets.json"
    path.write_text("{not json", encoding="utf-8")
    assert client.get("/api/presets").json() == []
    assert not path.exists()
    assert len(list(settings.data_dir.glob("presets.broken-*.json"))) == 1
    assert client.post("/api/presets", json=preset_body()).status_code == 200


def invalid(client: TestClient, body: dict[str, Any]) -> list[str]:
    r = client.post("/api/presets", json=body)
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "invalid_preset"
    return err["details"]["errors"]


def test_rejects_unknown_effect(client: TestClient) -> None:
    body = preset_body()
    body["effects"][0]["effect"] = "teleport"
    errors = invalid(client, body)
    assert len(errors) == 1 and "teleport" in errors[0]


def test_rejects_bad_params(client: TestClient) -> None:
    errors = invalid(client, preset_body(amount=1000, wobble=1, motionBlur=1, samples="8"))
    assert len(errors) == 4
    text = "\n".join(errors)
    for key in ("amount", "wobble", "motionBlur", "samples"):
        assert key in text
    assert client.get("/api/presets").json() == []


def test_rejects_bad_enum_and_color(client: TestClient) -> None:
    body = {
        "name": "x",
        "effects": [
            {"effect": "flash", "start": 0, "duration": 0.2, "params": {"color": "white", "blend": "burn"},
             "envelope": ENV},
        ],
    }  # fmt: skip
    assert len(invalid(client, body)) == 2


def test_structural_errors_are_validation_errors(client: TestClient) -> None:
    for body in (
        {"name": "x", "effects": []},
        {**preset_body(), "name": ""},
        {**preset_body(), "id": "pst_x"},
    ):
        r = client.post("/api/presets", json=body)
        assert r.status_code == 422
        assert r.json()["error"]["code"] == "validation_error"


def test_shared_registries_are_valid() -> None:
    reg = load_registry(SHARED)
    assert reg.errors == []
    assert "shake" in reg.effects and len(reg.effects) == len(load_json(SHARED / "effects.json")["effects"])


def broken_shared(tmp_path: Path) -> Path:
    shared = tmp_path / "shared"
    shutil.copytree(SHARED, shared, ignore=shutil.ignore_patterns("fixtures", "schema"))
    effects = load_json(shared / "effects.json")
    effects["effects"].append(effects["effects"][0])  # дубль shake
    effects["effects"][1]["params"][0]["default"] = 99  # zoomPunch.strength вне 0..2
    (shared / "effects.json").write_text(json.dumps(effects), encoding="utf-8")
    styles = load_json(shared / "styles.json")
    styles["styles"][0]["effects"][0]["effect"] = "teleport"
    (shared / "styles.json").write_text(json.dumps(styles), encoding="utf-8")
    return shared


def test_registry_errors_detected(tmp_path: Path) -> None:
    errors = load_registry(broken_shared(tmp_path)).errors
    text = "\n".join(errors)
    assert "повторяется id 'shake'" in text
    assert "zoomPunch.strength" in text
    assert "teleport" in text


def test_registry_errors_in_health(tmp_path: Path) -> None:
    settings = Settings(aieditor_data_dir=tmp_path / "data", aieditor_shared_dir=broken_shared(tmp_path))
    with TestClient(create_app(settings)) as c:
        health = c.get("/api/health").json()
        assert health["status"] == "ok"
        assert len(health["registryErrors"]) >= 3


def test_missing_registry_does_not_crash(tmp_path: Path) -> None:
    settings = Settings(aieditor_data_dir=tmp_path / "data", aieditor_shared_dir=tmp_path / "nowhere")
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/health").json()["registryErrors"] == ["effects.json: файл не найден"]
        assert invalid(c, preset_body()) == ["effects[0]: неизвестный эффект 'shake'"]


def test_health_without_registry_errors(client: TestClient) -> None:
    assert "registryErrors" not in client.get("/api/health").json()
