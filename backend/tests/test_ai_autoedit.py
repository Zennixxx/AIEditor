"""Фаза 7.5: автоэдит — слоты по маркерам, назначение моментов, сборка и проверка ops."""

from __future__ import annotations

from collections.abc import Iterator
from itertools import pairwise
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.autoedit import VIDEO_TRACK, build_slots, load_styles, motion_windows
from app.ai.timeline import clip_markers_on_timeline, find_clip
from app.ai.validate_ops import DryRun
from app.config import SHARED_DIR, Settings
from app.effects.registry import load_registry
from app.main import create_app
from app.models.gen import Asset, Clip, ClipAnalysis, Curve, Project, Shot
from app.models.ops import parse_op
from tests.conftest import FIXTURES, load_json, wait_until
from tests.fake_llm import FakeLLM

MUSIC_CLIP = "clp_music00001"
VIDEO_A = "ast_3f1c9a0b7d2e4c61"
VIDEO_B = "ast_8a7e5d4c3b2a1908"
SHORT = "ast_5bad5bad5bad5bad"


def project() -> Project:
    raw = load_json(FIXTURES / "project.json")
    short = {**raw["assets"][0], "id": SHORT, "name": "short.mp4", "duration": 1.0, "hasAudio": False}
    short["derived"] = {"proxy": f"/api/assets/{SHORT}/proxy.mp4"}
    raw["assets"].append(short)
    return Project.model_validate(raw)


def body(**extra: Any) -> dict[str, Any]:
    return {
        "project": project().model_dump(mode="json", by_alias=True, exclude_none=True),
        "musicClipId": MUSIC_CLIP,
        "assetIds": [VIDEO_A, VIDEO_B, SHORT],
        "style": "phonk",
        "intensity": 0.7,
        **extra,
    }


def apply(p: Project, ops: list[dict[str, Any]]) -> Project:
    dry = DryRun(
        p.model_copy(deep=True),
        load_registry(SHARED_DIR),
        lambda a: next((x for x in p.assets if x.id == a), None),
    )
    for op in ops:
        dry.apply(parse_op(op))
    assert dry.finalize() == []
    return dry.project


@pytest.fixture
def ai_app(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        state: Any = c.app.state  # type: ignore[attr-defined]
        state.clip_analysis.write(ClipAnalysis.model_validate(load_json(FIXTURES / "clip_analysis.json")))
        state.clip_analysis.write(
            ClipAnalysis(
                asset_id=VIDEO_B,
                model="",
                summary="",
                moments=[],
                shots=[Shot(start=0, end=3, type="other"), Shot(start=3, end=8, type="other")],
                motion=Curve(interval=0.1, values=[0.2] * 40 + [0.9] * 20 + [0.1] * 20),
            )
        )
        yield c


def run_job(client: TestClient, payload: dict[str, Any]) -> dict[str, Any]:
    res = client.post("/api/ai/auto-edit", json=payload)
    assert res.status_code == 200, res.json()

    def poll() -> dict[str, Any] | None:
        job = client.get(f"/api/jobs/{res.json()['jobId']}").json()
        return job if job["status"] in ("done", "failed", "canceled") else None

    job = wait_until(poll, timeout=20)
    assert job["status"] == "done", job
    return job["result"]


def check_edit(p: Project, result: dict[str, Any], span: tuple[float, float]) -> list[Any]:
    out = apply(p, result["ops"])
    track = next(t for t in out.tracks if t.name.startswith("Автоэдит"))
    clips = [c for c in track.items if isinstance(c, Clip)]
    assert clips, "автоэдит без клипов"
    frame = 1 / p.fps
    music = find_clip(p, MUSIC_CLIP)
    assert music is not None
    marker_times = [tm.t for tm in clip_markers_on_timeline(music[1])]
    assert clips[0].start == pytest.approx(span[0])
    assert clips[-1].start + clips[-1].duration == pytest.approx(span[1])
    assets = {a.id: a for a in p.assets}
    for prev, nxt in pairwise(clips):
        assert prev.start + prev.duration == pytest.approx(nxt.start, abs=1e-6)
        assert min(abs(nxt.start - t) for t in marker_times) <= frame
    for c in clips:
        assert c.source_out <= assets[c.asset_id].duration + 1e-6
        assert c.duration >= 2 * frame - 1e-6
    return clips


def test_fallback_without_gemini(ai_app: TestClient) -> None:
    result = run_job(ai_app, body())
    clips = check_edit(project(), result, (0.0, 96.0))
    assert "без Gemini" in result["explanation"]
    assert {c.asset_id for c in clips} >= {VIDEO_A, VIDEO_B}
    assert all(a.asset_id != b.asset_id or a.source_in != b.source_in for a, b in pairwise(clips))
    ops = {op["op"] for op in result["ops"]}
    assert {"addTrack", "addClip", "applyEffectToMarkers", "addEffect"} <= ops
    assert any("timeRemap" in op["clip"] for op in result["ops"] if op["op"] == "addClip")
    assert all(op["clip"].get("volume", 0) == 0 for op in result["ops"] if op["op"] == "addClip")


def test_range_and_zero_intensity(ai_app: TestClient) -> None:
    result = run_job(ai_app, body(range={"start": 30, "end": 45}, intensity=0))
    check_edit(project(), result, (30.0, 45.0))
    assert {op["op"] for op in result["ops"]} == {"addTrack", "addClip"}


def test_gemini_assignments_ramps_and_suggestions(ai_app: TestClient) -> None:
    def respond(parts: Any) -> dict[str, Any]:
        return {
            "assignments": [
                {"slot_id": "s1", "moment_id": "m2", "reason": "старт"},
                {"slot_id": "s999", "moment_id": "m1"},
            ],
            "ramps": [{"slot_id": "s1", "preset": "slow-end"}, {"slot_id": "s2", "preset": "nope"}],
            "effect_suggestions": [
                {"effect": "vignette", "kinds": ["downbeat"], "every": 2},
                {"effect": "unknown"},
            ],
        }

    fake = FakeLLM(respond)
    ai_app.app.state.llm = fake  # type: ignore[attr-defined]
    ai_app.app.state.clip_analysis.write(  # type: ignore[attr-defined]
        ClipAnalysis.model_validate({**load_json(FIXTURES / "clip_analysis.json"), "model": "gemini-pro"})
    )
    result = run_job(ai_app, body())
    clips = check_edit(project(), result, (0.0, 96.0))
    assert fake.calls[-1].tier == "pro" and "slots" in fake.calls[-1].text
    first = next(op["clip"] for op in result["ops"] if op["op"] == "addClip")
    assert first["timeRemap"]["keyframes"][-1]["speed"] == pytest.approx(0.2)
    assert clips[0].time_remap is not None
    assert any(op.get("effect") == "vignette" for op in result["ops"] if op["op"] == "applyEffectToMarkers")
    assert any("не назначил" in w for w in result["warnings"])
    assert "без Gemini" not in result["explanation"]


def test_request_errors(ai_app: TestClient) -> None:
    def code(payload: dict[str, Any]) -> tuple[int, str]:
        res = ai_app.post("/api/ai/auto-edit", json=payload)
        return res.status_code, res.json()["error"]["code"]

    assert code(body(style="nope")) == (422, "unknown_style")
    assert code(body(style="custom")) == (422, "unknown_style")
    assert code(body(musicClipId="clp_missing0001")) == (422, "clip_not_found")
    assert code(body(assetIds=["ast_c0ffee1234abcd56"])) == (422, "not_video")
    assert code(body(assetIds=["ast_0000000000000000"])) == (404, "asset_not_found")
    assert code(body(range={"start": 200, "end": 300})) == (422, "bad_range")


def test_slots_follow_style_density() -> None:
    p = project()
    styles = load_styles(SHARED_DIR)
    slots = build_slots(p, MUSIC_CLIP, (0.0, 96.0), styles["phonk"])
    drop = [s for s in slots if s.label == "drop"]
    intro = [s for s in slots if s.label == "intro"]
    assert drop and intro
    assert sum(s.duration for s in drop) / len(drop) < sum(s.duration for s in intro) / len(intro)


def test_motion_windows_prefer_movement() -> None:
    asset = Asset.model_validate(next(a for a in load_json(FIXTURES / "assets.json") if a["id"] == VIDEO_B))
    analysis = ClipAnalysis(
        asset_id=VIDEO_B,
        model="",
        summary="",
        moments=[],
        shots=[Shot(start=0, end=8, type="other")],
        motion=Curve(interval=0.1, values=[0.1] * 50 + [1.0] * 30),
    )
    windows = motion_windows(asset, analysis)
    best = max(windows, key=lambda w: w[2])
    assert best[0] >= 5.0 and best[2] == 1.0
    assert all(b <= 8.0 for _, b, _ in windows)
    assert VIDEO_TRACK.startswith("tmp_")
