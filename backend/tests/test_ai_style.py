"""Фаза 7.6: стиль по референсу — плотность склеек из DSP, эффекты от Gemini."""

from __future__ import annotations

from collections.abc import Iterator
from itertools import pairwise
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.style import GeminiStyleResponse, build_style, cut_density_map, dsp_stats, section_density
from app.config import SHARED_DIR, Settings
from app.effects.registry import load_registry
from app.main import create_app
from app.models.gen import Asset, ClipAnalysis, Curve, MusicAnalysis, Shot
from tests.conftest import FIXTURES, load_json, wait_until
from tests.fake_llm import FakeLLM

VIDEO_ID = "ast_3f1c9a0b7d2e4c61"


def asset() -> Asset:
    return Asset.model_validate(next(a for a in load_json(FIXTURES / "assets.json") if a["id"] == VIDEO_ID))


def music(asset_id: str = VIDEO_ID) -> MusicAnalysis:
    return MusicAnalysis.model_validate({**load_json(FIXTURES / "music_analysis.json"), "assetId": asset_id})


def drop_cuts(m: MusicAnalysis) -> list[float]:
    return [b.t + 0.02 for b in m.bass if 30 <= b.t < 60 and b.strength >= 0.5]


def test_cuts_on_strong_bass_give_bass_density() -> None:
    m = music()
    density, on_bass, _ = section_density(30, 60, drop_cuts(m), m)
    assert density["kinds"] == ["bass"] and density["every"] == 1
    assert 0.4 <= density["minStrength"] <= 0.55
    assert on_bass == len(drop_cuts(m))


def test_density_without_music_and_without_cuts() -> None:
    assert section_density(0, 10, [], None)[0] == {"kinds": ["downbeat"], "every": 2, "minStrength": 0}
    density = section_density(0, 10, [2.0, 4.0, 6.0, 8.0], None)[0]
    assert density == {"kinds": ["beat", "downbeat"], "every": 5, "minStrength": 0}


def test_density_map_covers_all_labels() -> None:
    m = music()
    cuts = [*drop_cuts(m), 5.0, 10.0]
    stats = dsp_stats(96.0, cuts, m)
    assert [s.label for s in stats] == [s.label for s in m.sections]
    density = cut_density_map(stats, 96.0, cuts, m)
    assert set(density) == {"intro", "verse", "build", "drop", "break", "outro", "other"}
    assert density["drop"]["kinds"] == ["bass"]


def test_build_style_drops_unknown_effects() -> None:
    registry = load_registry(SHARED_DIR)
    resp = GeminiStyleResponse.model_validate(
        {
            "name": "Неон",
            "description": "d",
            "effects": [
                {"effect": "shake", "kinds": ["bass"], "min_strength": 0.6, "probability": 1.5},
                {"effect": "whipPan"},
                {"effect": "nope"},
            ],
            "global_effects": ["filmGrain", "filmGrain", "glitchTransition"],
            "ramps": [
                {"preset": "slow-end", "where": "section-end", "probability": 0.5},
                {"preset": "x", "where": "random", "probability": 1},
            ],
            "transitions": [
                {"effect": "whipPan", "at": "downbeat", "probability": 0.3},
                {"effect": "shake", "at": "downbeat", "probability": 1},
            ],
        }
    )
    m = music()
    density = cut_density_map(dsp_stats(96.0, [], m), 96.0, [], m)
    style = build_style(asset(), density, resp, registry, {"slow-end": None})  # type: ignore[dict-item]
    assert style.id == "ref_3f1c9a0b7d2e4c61" and style.name == "Неон"
    assert [e.effect for e in style.effects] == ["shake"] and style.effects[0].probability == 1.0
    assert style.effects[0].filter.min_strength == pytest.approx(0.6)
    assert [g.effect for g in style.global_effects or []] == ["filmGrain"]
    assert [r.preset for r in style.ramps] == ["slow-end"]
    assert [t.effect for t in style.transitions] == ["whipPan"]
    assert build_style(asset(), density, None, registry, {}).effects == []


@pytest.fixture
def ai_app(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        state: Any = c.app.state  # type: ignore[attr-defined]
        state.assets.save(asset())
        (state.paths.asset_dir(VIDEO_ID) / "proxy.mp4").write_bytes(b"video")
        m = music()
        shots_at = [0.0, *drop_cuts(m), 96.0]
        state.clip_analysis.write(
            ClipAnalysis(
                asset_id=VIDEO_ID,
                model="",
                summary="",
                moments=[],
                shots=[Shot(start=a, end=b, type="other") for a, b in pairwise(shots_at)],
                motion=Curve(interval=0.1, values=[]),
            )
        )
        state.analysis.replace(m)
        yield c


def test_style_endpoint(ai_app: TestClient) -> None:
    fake = FakeLLM(
        {
            "name": "Фонк",
            "description": "Тряска на басах",
            "effects": [{"effect": "shake", "kinds": ["bass"]}],
        }
    )
    ai_app.app.state.llm = fake  # type: ignore[attr-defined]
    res = ai_app.post(f"/api/ai/style-from-reference/{VIDEO_ID}")
    assert res.status_code == 200, res.json()

    def poll() -> dict[str, Any] | None:
        job = ai_app.get(f"/api/jobs/{res.json()['jobId']}").json()
        return job if job["status"] in ("done", "failed") else None

    job = wait_until(poll, timeout=10)
    assert job["status"] == "done", job
    style = job["result"]
    assert style["name"] == "Фонк" and style["cutDensity"]["drop"]["kinds"] == ["bass"]
    assert fake.calls[0].tier == "pro" and "onBassShare" in fake.calls[0].text
    saved = ai_app.get("/api/presets/styles").json()
    assert [s["id"] for s in saved] == [style["id"]]
    assert ai_app.get("/api/presets").json() == []
