"""Фаза 7.2–7.3: ИИ-анализ клипа и секций музыки (фейковый LLM)."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.client import LLMError
from app.ai.clip import GeminiClipResponse, merge_analysis, refine_bounds
from app.ai.music import GeminiMusicResponse, accepted_edges, enrich_sections
from app.config import Settings
from app.main import create_app
from app.models.gen import Asset, ClipAnalysis, Curve, MusicAnalysis, Shot
from tests.conftest import FIXTURES, load_json, wait_until
from tests.fake_llm import FakeLLM

ASSETS = {a["id"]: a for a in load_json(FIXTURES / "assets.json")}
VIDEO_ID = "ast_3f1c9a0b7d2e4c61"
MUSIC_ID = "ast_c0ffee1234abcd56"


def local_clip(duration: float = 10.0) -> ClipAnalysis:
    values = [0.8] * int(duration * 10)
    for i in (12, 13, 38, 61):
        values[i] = 0.1
    return ClipAnalysis(
        asset_id=VIDEO_ID,
        model="",
        summary="",
        moments=[],
        shots=[Shot(start=0.0, end=4.0, type="other"), Shot(start=4.0, end=duration, type="other")],
        motion=Curve(interval=0.1, values=values),
    )


def music() -> MusicAnalysis:
    return MusicAnalysis.model_validate(load_json(FIXTURES / "music_analysis.json"))


# ---------- анализ клипа ----------


def test_refine_expands_to_motion_minimum_within_shot() -> None:
    local = local_clip()
    assert refine_bounds(1.5, 3.5, local.motion, local.shots, 10.0) == (1.3, 3.8)
    # минимум 0.38 с до начала в соседнем плане не берётся, конец ищется в пределах 0.5 с
    assert refine_bounds(4.2, 5.5, local.motion, local.shots, 10.0) == (4.2, 5.5)
    assert refine_bounds(5.0, 5.7, local.motion, local.shots, 10.0) == (5.0, 6.1)


def test_refine_without_motion_keeps_bounds() -> None:
    shots = [Shot(start=0.0, end=10.0, type="other")]
    assert refine_bounds(1.0, 2.0, Curve(interval=0.1, values=[]), shots, 10.0) == (1.0, 2.0)


def test_merge_clamps_filters_and_types_shots() -> None:
    resp = GeminiClipResponse.model_validate(
        {
            "summary": " Бег по улице. ",
            "moments": [
                {
                    "start": 8.0,
                    "end": 12.0,
                    "score": 1.4,
                    "tags": ["Action", "action", " run "],
                    "description": "",
                },
                {"start": -1.0, "end": 1.0, "score": 0.5, "tags": [], "description": "y"},
                {"start": 5.0, "end": 5.1, "score": 0.9, "tags": [], "description": "слишком короткий"},
                {"start": 9.99, "end": 11.0, "score": 0.9, "tags": [], "description": "за концом"},
            ],
            "shot_types": [
                {"start": 0.0, "end": 3.0, "type": "wide"},
                {"start": 3.0, "end": 4.5, "type": "closeup"},
                {"start": 4.5, "end": 10.0, "type": "closeup"},
            ],
        }
    )
    a = merge_analysis(local_clip(), resp, 10.0, "gemini-pro")
    assert a.model == "gemini-pro" and a.summary == "Бег по улице."
    assert [(m.start, m.end) for m in a.moments] == [(0.0, 1.2), (8.0, 10.0)]
    assert a.moments[1].score == 1.0 and a.moments[1].tags == ["action", "run"]
    assert [s.type for s in a.shots] == ["wide", "closeup"]
    assert a.motion == local_clip().motion


# ---------- секции музыки ----------


def test_music_edges_snap_to_dsp_or_downbeat_and_reject_others() -> None:
    m = music()
    downbeat = next(t for t in m.downbeats if 40 < t < 50)
    resp = GeminiMusicResponse.model_validate(
        {
            "sections": [
                {"start": 0, "end": 30.1, "label": "intro", "description": "тихо"},
                {"start": 30.1, "end": downbeat + 0.15, "label": "drop", "description": "дроп"},
                {"start": downbeat + 0.15, "end": 67.3, "label": "drop", "description": "дроп 2"},
                {"start": 67.3, "end": 96, "label": "outro", "description": "конец"},
            ]
        }
    )
    edges = accepted_edges(m, resp)
    assert edges == [0.0, 30.0, downbeat, 96.0]
    sections = enrich_sections(m, resp)
    assert [s.label for s in sections] == ["intro", "drop", "outro"]
    assert sections[0].description == "тихо"
    assert all(0 <= s.energy <= 1 for s in sections)


def test_music_without_answer_keeps_dsp_sections() -> None:
    m = music()
    assert enrich_sections(m, GeminiMusicResponse()) == m.sections


# ---------- эндпоинты ----------


@pytest.fixture
def ai_app(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        state: Any = c.app.state  # type: ignore[attr-defined]
        for asset_id in (VIDEO_ID, MUSIC_ID):
            asset = Asset.model_validate(ASSETS[asset_id])
            state.assets.save(asset)
            (state.paths.asset_dir(asset_id) / "proxy.mp4").write_bytes(b"video")
            (state.paths.asset_dir(asset_id) / "audio.m4a").write_bytes(b"audio")
        local = local_clip(12.0)
        state.clip_analysis.write(local)
        state.analysis.replace(music())
        yield c


def finished(client: TestClient, job_id: str) -> dict[str, Any]:
    def poll() -> dict[str, Any] | None:
        job = client.get(f"/api/jobs/{job_id}").json()
        return job if job["status"] in ("done", "failed", "canceled") else None

    return wait_until(poll, timeout=10)


def test_analyze_clip_endpoint(ai_app: TestClient) -> None:
    res = ai_app.post(f"/api/ai/analyze-clip/{VIDEO_ID}", json={})
    assert res.status_code == 503 and res.json()["error"]["code"] == "gemini_not_configured"

    fake = FakeLLM(
        {"summary": "s", "moments": [{"start": 1, "end": 2, "score": 0.7, "tags": [], "description": ""}]},
        {"summary": "s2", "moments": []},
    )
    ai_app.app.state.llm = fake  # type: ignore[attr-defined]
    job = finished(ai_app, ai_app.post(f"/api/ai/analyze-clip/{VIDEO_ID}").json()["jobId"])
    assert job["status"] == "done", job
    assert job["result"]["model"] == "fake-pro" and len(job["result"]["moments"]) == 1
    assert fake.calls[0].tier == "pro" and "ПЛАНЫ" in fake.calls[0].text
    assert fake.uploads[0].name == "proxy.mp4"
    assert ai_app.get(f"/api/analysis/clip/{VIDEO_ID}").json()["summary"] == "s"

    job = finished(ai_app, ai_app.post(f"/api/ai/analyze-clip/{VIDEO_ID}", json={}).json()["jobId"])
    assert job["result"]["summary"] == "s" and len(fake.calls) == 1
    res = ai_app.post(f"/api/ai/analyze-clip/{VIDEO_ID}", json={"force": True})
    job = finished(ai_app, res.json()["jobId"])
    assert job["result"]["summary"] == "s2"

    res = ai_app.post(f"/api/ai/analyze-clip/{MUSIC_ID}")
    assert res.status_code == 422 and res.json()["error"]["code"] == "not_video"
    assert ai_app.post("/api/ai/analyze-clip/ast_0000000000000000").status_code == 404


def test_analyze_clip_gemini_failure_fails_job(ai_app: TestClient) -> None:
    ai_app.app.state.llm = FakeLLM(LLMError("gemini_failed", "нет сети"))  # type: ignore[attr-defined]
    job = finished(ai_app, ai_app.post(f"/api/ai/analyze-clip/{VIDEO_ID}").json()["jobId"])
    assert job["status"] == "failed" and job["error"]["code"] == "gemini_failed"


def test_analyze_music_endpoint(ai_app: TestClient) -> None:
    fake = FakeLLM(
        {
            "mood": "dark",
            "sections": [
                {"start": 0, "end": 30, "label": "intro", "description": "вступление"},
                {"start": 30, "end": 96, "label": "drop", "description": "дроп"},
            ],
        }
    )
    ai_app.app.state.llm = fake  # type: ignore[attr-defined]
    job = finished(ai_app, ai_app.post(f"/api/ai/analyze-music/{MUSIC_ID}").json()["jobId"])
    assert job["status"] == "done", job
    assert [s["label"] for s in job["result"]["sections"]] == ["intro", "drop"]
    assert fake.uploads[0].name == "audio.m4a" and "ДАУНБИТЫ" in fake.calls[0].text
    stored = ai_app.get(f"/api/analysis/music/{MUSIC_ID}").json()
    assert stored["sections"][1]["description"] == "дроп"
