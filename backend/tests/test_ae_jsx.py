from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.effects.registry import load_registry
from app.export.ae_jsx import ae_data, anim_spec, build_ae_jsx, clip_timing, content_disposition
from app.models.gen import Clip, Keyframe, Project
from app.timeremap import keys_from_json, source_time

from .conftest import FIXTURES, load_json

SNAPSHOT = Path(__file__).parent / "snapshots" / "ae_jsx_project.jsx"


def fixture_project() -> Project:
    return Project.model_validate(load_json(FIXTURES / "project.json"))


def layers_by_name(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {layer["name"]: layer for layer in data["layers"]}


def clip_of(project: Project, clip_id: str) -> Clip:
    for track in project.tracks:
        for item in track.items:
            if isinstance(item, Clip) and item.id == clip_id:
                return item
    raise KeyError(clip_id)


def test_snapshot_matches_fixture_project() -> None:
    registry = load_registry(Settings().aieditor_shared_dir)
    script = build_ae_jsx(fixture_project(), registry)
    if os.environ.get("AIEDITOR_UPDATE_SNAPSHOTS") == "1" or not SNAPSHOT.exists():
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(script, encoding="utf-8", newline="\n")
    assert script == SNAPSHOT.read_text(encoding="utf-8")
    assert script.isascii()


def test_layers_follow_track_order_bottom_to_top() -> None:
    project = fixture_project()
    data = ae_data(project)
    kinds = [layer.get("kind", "fx") for layer in data["layers"]]
    assert kinds == ["video"] * 5 + ["fx", "fx"] + ["audio"]
    assert data["layers"][0]["name"] == "intro slow"
    assert data["layers"][5]["name"] == "FX: FX"
    assert all(layer["adjustment"] for layer in data["layers"][5:7])
    assert data["comp"]["fps"] == 30
    assert data["comp"]["duration"] == pytest.approx(96.0)
    assert {a["id"] for a in data["assets"]} == {a.id for a in project.assets}


def test_plain_clip_uses_start_time_without_remap() -> None:
    project = fixture_project()
    clip = clip_of(project, "clp_drop000001")
    layer = next(lyr for lyr in ae_data(project)["layers"] if lyr.get("in") == clip.start)
    assert layer["remap"] is None
    assert layer["startTime"] == pytest.approx(clip.start - clip.source_in)
    assert layer["out"] == pytest.approx(clip.start + clip.duration)
    assert any(m["c"].startswith("fx: ") for m in layer["markers"])


def test_constant_speed_and_reverse_become_two_remap_keys() -> None:
    project = fixture_project()
    slow = clip_of(project, "clp_intro00001")
    timing = clip_timing(slow, 30)
    assert not timing.plain
    assert timing.samples == [(0.0, 0.0), (15.0, 7.5)]
    rev = clip_of(project, "clp_drop000002").model_copy(update={"reverse": True, "time_remap": None})
    timing = clip_timing(rev, 30)
    assert timing.samples[0][1] == pytest.approx(rev.source_in + rev.speed * rev.duration)
    assert timing.samples[-1][1] == pytest.approx(rev.source_in)


def test_time_remap_sampled_per_frame() -> None:
    project = fixture_project()
    clip = clip_of(project, "clp_drop000002")
    assert clip.time_remap is not None
    timing = clip_timing(clip, 30)
    expected_count = int(clip.duration * 30 + 1e-9) + 1
    assert len(timing.samples) in (expected_count, expected_count + 1)
    assert timing.samples[-1][0] == pytest.approx(clip.duration)
    keys = keys_from_json([k.model_dump(by_alias=True) for k in clip.time_remap.keyframes])
    for tau, src in timing.samples:
        ref = source_time(
            keys, clip.time_remap.fit, clip.duration, clip.source_in, clip.source_out, tau, clip.reverse
        )
        assert src == pytest.approx(ref, abs=1e-9)
    mid = (timing.samples[3][1] + timing.samples[4][1]) / 2
    t = timing.comp_of_source(mid)
    assert t is not None
    assert clip.start + timing.samples[3][0] <= t <= clip.start + timing.samples[4][0]


def test_keyframes_get_bezier_eases() -> None:
    keys = [
        Keyframe(t=0, v=1.0, ease="easeInOut"),
        Keyframe(t=1, v=2.0, ease="hold"),
        Keyframe(t=2, v=0.0, ease="linear"),
    ]
    spec = anim_spec(keys, 10.0)
    assert isinstance(spec, list)
    assert [k["t"] for k in spec] == [10.0, 11.0, 12.0]
    assert spec[0]["o"] == "bezier" and spec[1]["i"] == "bezier"
    assert spec[0]["oS"] == pytest.approx(0.0)
    assert spec[0]["oI"] == pytest.approx(42.0)
    assert spec[1]["iI"] == pytest.approx(42.0)
    assert spec[1]["o"] == "hold"
    assert anim_spec(2.5, 0.0, lambda v: v * 2) == 5.0
    flat = anim_spec(keys, 0.0, eased=False)
    assert isinstance(flat, list)
    assert flat[0]["o"] == "linear" and "oS" not in flat[0]


def test_volume_becomes_decibels() -> None:
    project = fixture_project()
    music = next(lyr for lyr in ae_data(project)["layers"] if lyr.get("kind") == "audio")
    assert music["levels"] == pytest.approx(0.0)
    assert music["transform"] is None


def test_content_disposition_is_ascii_safe() -> None:
    header = content_disposition('Эдит: "дроп".jsx')
    assert header.isascii()
    assert "filename*=UTF-8''" in header
    assert '"' not in header.split("filename=", 1)[1].split(";")[0].strip('"')


def test_endpoint_returns_script(client: TestClient) -> None:
    body = load_json(FIXTURES / "project.json")
    res = client.post("/api/export/ae-jsx", json=body)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/javascript")
    assert "attachment" in res.headers["content-disposition"]
    assert res.text.startswith("// AIEditor")
    assert "var DATA = " in res.text


def test_endpoint_rejects_invalid_project(client: TestClient) -> None:
    res = client.post("/api/export/ae-jsx", json={"name": "x"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"


@pytest.mark.skipif(shutil.which("node") is None, reason="node не найден")
def test_script_is_valid_javascript(tmp_path: Path) -> None:
    path = tmp_path / "out.js"
    path.write_text(build_ae_jsx(fixture_project()), encoding="utf-8")
    node = shutil.which("node")
    assert node is not None
    res = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
