from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.config import SCHEMA_VERSION
from app.models.gen import Health, Job


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    Health.model_validate(body)
    assert body["status"] == "ok"
    assert body["schemaVersion"] == SCHEMA_VERSION
    assert body["gemini"] is False


def test_unknown_job_uses_error_format(client: TestClient) -> None:
    r = client.get("/api/jobs/job_missing")
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "job_not_found", "message": "Задача job_missing не найдена"}}


def test_validation_error_format(client: TestClient) -> None:
    r = client.post("/api/debug/sleep-job", json={"seconds": -1})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def _collect_job_events(ws: Any, job_id: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while True:
        msg = ws.receive_json()
        if msg["type"] != "job" or msg["job"]["id"] != job_id:
            continue
        events.append(msg["job"])
        if msg["job"]["status"] in ("done", "failed", "canceled"):
            return events


def test_dummy_job_lifecycle_over_ws(client: TestClient) -> None:
    with client.websocket_connect("/api/ws") as ws:
        hello = ws.receive_json()
        assert hello == {"type": "hello", "version": hello["version"], "schemaVersion": SCHEMA_VERSION}

        r = client.post("/api/debug/sleep-job", json={"seconds": 0.6, "steps": 6})
        assert r.status_code == 200
        job_id = r.json()["jobId"]

        events = _collect_job_events(ws, job_id)

    statuses = [e["status"] for e in events]
    assert statuses[0] == "queued"
    assert "running" in statuses
    assert statuses[-1] == "done"
    progresses = [e["progress"] for e in events]
    assert progresses == sorted(progresses)
    for e in events:
        Job.model_validate(e)
    assert events[-1]["result"] == {"steps": 6}

    final = client.get(f"/api/jobs/{job_id}").json()
    assert final["status"] == "done"
    assert final["progress"] == 1


def test_cancel_job(client: TestClient) -> None:
    with client.websocket_connect("/api/ws") as ws:
        ws.receive_json()
        job_id = client.post("/api/debug/sleep-job", json={"seconds": 30, "steps": 30}).json()["jobId"]
        r = client.delete(f"/api/jobs/{job_id}")
        assert r.status_code == 200
        events = _collect_job_events(ws, job_id)
    assert events[-1]["status"] == "canceled"
