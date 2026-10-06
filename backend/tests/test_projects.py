"""Фаза 1.x: CRUD проектов, оптимистичная блокировка, история — CONTRACT §8–9."""

from __future__ import annotations

import copy
from datetime import datetime
from typing import Any

from fastapi.testclient import TestClient

from app.models.gen import Project, ProjectListItem
from app.storage.projects_repo import HISTORY_LIMIT
from tests.conftest import FIXTURES, load_json
from tests.test_shared_contract import validate

SERVER_FIELDS = ("id", "revision", "createdAt", "updatedAt")


def _create(client: TestClient, name: str = "Edit", fps: int = 30) -> dict[str, Any]:
    r = client.post("/api/projects", json={"name": name, "fps": fps, "width": 1920, "height": 1080})
    assert r.status_code == 200, r.text
    return r.json()


def test_create_returns_empty_project(client: TestClient) -> None:
    p = _create(client, "Новый", fps=60)
    Project.model_validate(p)
    validate(p, "Project")
    assert p["id"].startswith("prj_") and len(p["id"]) == 14
    assert p["revision"] == 0 and p["schemaVersion"] == 1
    assert (p["name"], p["fps"], p["width"], p["height"]) == ("Новый", 60, 1920, 1080)
    assert p["assets"] == p["tracks"] == p["markers"] == p["sections"] == []
    assert p["createdAt"] == p["updatedAt"]
    assert client.get(f"/api/projects/{p['id']}").json() == p


def test_create_validates_body(client: TestClient) -> None:
    r = client.post("/api/projects", json={"name": "x", "fps": 29, "width": 1920, "height": 1080})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_get_missing_project(client: TestClient) -> None:
    for pid in ("prj_missing000", "not-a-project", "prj_..%5C..%5Cx"):
        r = client.get(f"/api/projects/{pid}")
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "project_not_found"


def test_save_fixture_project_roundtrip(client: TestClient) -> None:
    created = _create(client)
    fixture = load_json(FIXTURES / "project.json")
    body = {**copy.deepcopy(fixture), "id": created["id"], "revision": 0}

    r = client.put(f"/api/projects/{created['id']}", json=body)
    assert r.status_code == 200, r.text
    saved = r.json()
    validate(saved, "Project")
    assert saved["revision"] == 1
    assert saved["createdAt"] == created["createdAt"]
    assert datetime.fromisoformat(saved["updatedAt"]) > datetime.fromisoformat(created["updatedAt"])
    # форма ответа совпадает с фикстурой (без null-полей, camelCase, те же значения)
    strip = lambda d: {k: v for k, v in d.items() if k not in SERVER_FIELDS}  # noqa: E731
    assert strip(saved) == strip(fixture)
    assert client.get(f"/api/projects/{created['id']}").json() == saved


def test_revision_conflict_and_history(client: TestClient, settings: Any) -> None:
    p = _create(client)
    pid = p["id"]
    for i in range(HISTORY_LIMIT + 5):
        p = client.put(f"/api/projects/{pid}", json={**p, "name": f"v{i + 1}"}).json()
        assert p["revision"] == i + 1
    total = HISTORY_LIMIT + 5

    stale = {**p, "revision": total - 1, "name": "stale"}
    r = client.put(f"/api/projects/{pid}", json=stale)
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "revision_conflict" and err["details"] == {"revision": total}
    assert client.get(f"/api/projects/{pid}").json()["name"] == f"v{total}"

    hist = settings.data_dir / "projects" / f"{pid}.history"
    revisions = sorted(int(f.stem) for f in hist.glob("*.json"))
    assert revisions == list(range(total - HISTORY_LIMIT, total))
    prev = load_json(hist / f"{total - 1}.json")
    assert prev["revision"] == total - 1 and prev["name"] == f"v{total - 1}"
    validate(prev, "Project")
    assert not list((settings.data_dir / "projects").glob("*.part-*"))


def test_put_validation(client: TestClient) -> None:
    p = _create(client)
    other = _create(client)
    r = client.put(f"/api/projects/{p['id']}", json={**p, "fps": 31})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    r = client.put(f"/api/projects/{p['id']}", json=other)
    assert r.status_code == 400 and r.json()["error"]["code"] == "project_id_mismatch"
    missing = {**p, "id": "prj_nothere0000", "revision": 3}
    r = client.put("/api/projects/prj_nothere0000", json=missing)
    assert r.status_code == 404 and r.json()["error"]["code"] == "project_not_found"


def test_put_creates_new_project_with_revision_zero(client: TestClient, settings: Any) -> None:
    fixture = load_json(FIXTURES / "project.json")
    body = {**copy.deepcopy(fixture), "id": "prj_fromfront1", "revision": 0}
    r = client.put("/api/projects/prj_fromfront1", json=body)
    assert r.status_code == 200, r.text
    saved = r.json()
    validate(saved, "Project")
    assert saved["revision"] == 1 and saved["createdAt"] == saved["updatedAt"]
    assert client.get("/api/projects/prj_fromfront1").json() == saved
    assert not (settings.data_dir / "projects" / "prj_fromfront1.history").exists()
    r = client.put("/api/projects/prj_fromfront1", json=body)
    assert r.status_code == 409 and r.json()["error"]["details"] == {"revision": 1}


def test_delete_project_with_history(client: TestClient, settings: Any) -> None:
    p = _create(client)
    client.put(f"/api/projects/{p['id']}", json=p)
    hist = settings.data_dir / "projects" / f"{p['id']}.history"
    assert hist.is_dir()
    r = client.delete(f"/api/projects/{p['id']}")
    assert r.status_code == 204 and r.content == b""
    assert not hist.exists()
    assert client.get(f"/api/projects/{p['id']}").status_code == 404
    assert client.get("/api/projects").json() == []
    r = client.delete(f"/api/projects/{p['id']}")
    assert r.status_code == 404 and r.json()["error"]["code"] == "project_not_found"


def test_list_sorted_by_updated_desc(client: TestClient) -> None:
    a = _create(client, "A")
    b = _create(client, "B")
    c = _create(client, "C")
    client.put(f"/api/projects/{a['id']}", json=a)  # A — самый свежий
    items = client.get("/api/projects").json()
    for it in items:
        ProjectListItem.model_validate(it)
        validate(it, "ProjectListItem")
        assert set(it) == {"id", "name", "updatedAt"}
    assert [it["id"] for it in items] == [a["id"], c["id"], b["id"]]
