"""Проверка shared/: фикстуры валидны по схеме, реестры согласованы, инварианты проекта соблюдены."""

from __future__ import annotations

import itertools
from typing import Any

import pytest
from jsonschema import Draft7Validator

from app.models.gen import (
    ClipAnalysis,
    EffectsRegistry,
    Job,
    MusicAnalysis,
    OpsResult,
    Project,
    StylesFile,
)
from app.tools.gen_models import merged_schema
from tests.conftest import FIXTURES, SHARED, load_json

SCHEMA = merged_schema()


def validate(instance: Any, definition: str) -> None:
    schema = {"$ref": f"#/definitions/{definition}", "definitions": SCHEMA["definitions"]}
    errors = sorted(Draft7Validator(schema).iter_errors(instance), key=lambda e: list(e.path))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors[:10])


CASES = [
    ("health.json", "Health", False),
    ("assets.json", "Asset", True),
    ("music_analysis.json", "MusicAnalysis", False),
    ("waveform_music.json", "Waveform", False),
    ("thumbs_video_a.json", "Thumbs", False),
    ("clip_analysis.json", "ClipAnalysis", False),
    ("project.json", "Project", False),
    ("jobs.json", "Job", True),
    ("ops_result.json", "OpsResult", False),
    ("ai_commands.json", "AiCommandsFile", False),
    ("ramp_presets.json", "RampPresetsFile", False),
    ("time_remap_vectors.json", "TimeRemapVectorsFile", False),
    ("presets.json", "EffectPreset", True),
]


def test_schema_is_valid_draft7() -> None:
    Draft7Validator.check_schema(SCHEMA)


@pytest.mark.parametrize(("name", "definition", "is_list"), CASES, ids=[c[0] for c in CASES])
def test_fixture_matches_schema(name: str, definition: str, is_list: bool) -> None:
    data = load_json(FIXTURES / name)
    for item in data if is_list else [data]:
        validate(item, definition)


def test_registries_match_schema() -> None:
    validate(load_json(SHARED / "effects.json"), "EffectsRegistry")
    validate(load_json(SHARED / "styles.json"), "StylesFile")


def test_fixtures_parse_with_pydantic() -> None:
    Project.model_validate(load_json(FIXTURES / "project.json"))
    MusicAnalysis.model_validate(load_json(FIXTURES / "music_analysis.json"))
    ClipAnalysis.model_validate(load_json(FIXTURES / "clip_analysis.json"))
    OpsResult.model_validate(load_json(FIXTURES / "ops_result.json"))
    EffectsRegistry.model_validate(load_json(SHARED / "effects.json"))
    StylesFile.model_validate(load_json(SHARED / "styles.json"))
    for j in load_json(FIXTURES / "jobs.json"):
        Job.model_validate(j)


def test_effect_defaults_within_ranges() -> None:
    reg = load_json(SHARED / "effects.json")
    ids = [e["id"] for e in reg["effects"]]
    assert len(ids) == len(set(ids)), "duplicate effect ids"
    for e in reg["effects"]:
        keys = [p["key"] for p in e["params"]]
        assert len(keys) == len(set(keys)), e["id"]
        for p in e["params"]:
            d = p["default"]
            if p["type"] == "number":
                assert isinstance(d, int | float) and not isinstance(d, bool), (e["id"], p["key"])
                assert p.get("min", d) <= d <= p.get("max", d), (e["id"], p["key"])
            elif p["type"] == "boolean":
                assert isinstance(d, bool), (e["id"], p["key"])
            elif p["type"] == "enum":
                assert d in p["options"], (e["id"], p["key"])
            elif p["type"] == "color":
                assert isinstance(d, str) and d.startswith("#"), (e["id"], p["key"])


def _effect_params_ok(effect_id: str, params: dict[str, Any]) -> None:
    reg = {e["id"]: e for e in load_json(SHARED / "effects.json")["effects"]}
    assert effect_id in reg, f"unknown effect {effect_id}"
    defs = {p["key"]: p for p in reg[effect_id]["params"]}
    for k, v in params.items():
        assert k in defs, f"{effect_id}: unknown param {k}"
        p = defs[k]
        if p["type"] == "number":
            assert p.get("min", v) <= v <= p.get("max", v), f"{effect_id}.{k}={v}"


def test_styles_reference_known_effects_and_ramps() -> None:
    ramps = {p["id"] for p in load_json(FIXTURES / "ramp_presets.json")["presets"]}
    for s in load_json(SHARED / "styles.json")["styles"]:
        for rule in s["effects"] + s.get("globalEffects", []):
            _effect_params_ok(rule["effect"], rule["params"])
        for t in s["transitions"]:
            _effect_params_ok(t["effect"], {})
        for r in s["ramps"]:
            assert r["preset"] in ramps, (s["id"], r["preset"])


def test_project_invariants() -> None:
    p = load_json(FIXTURES / "project.json")
    assets = {a["id"]: a for a in p["assets"]}
    marker_ids = {m["id"] for m in p["markers"]}
    for track in p["tracks"]:
        for c in track["items"]:
            if c["type"] == "clip":
                marker_ids |= {m["id"] for m in c["markers"]}

    for track in p["tracks"]:
        items = track["items"]
        expected_type = "effect" if track["kind"] == "fx" else "clip"
        starts = [i["start"] for i in items]
        assert starts == sorted(starts), f"{track['id']}: items not sorted"
        for a, b in itertools.pairwise(items):
            assert a["start"] + a["duration"] <= b["start"] + 1e-6, f"overlap {a['id']} / {b['id']}"
        for item in items:
            assert item["type"] == expected_type, f"{item['id']} on {track['kind']} track"
            effects = [item] if item["type"] == "effect" else item["effects"]
            if item["type"] == "clip":
                asset = assets[item["assetId"]]
                assert 0 <= item["sourceIn"] < item["sourceOut"] <= asset["duration"], item["id"]
                if "timeRemap" not in item:
                    expected = (item["sourceOut"] - item["sourceIn"]) / item["speed"]
                    assert item["duration"] == pytest.approx(expected, abs=1e-4), item["id"]
            for fx in effects:
                _effect_params_ok(fx["effect"], fx["params"])
                if "anchor" in fx:
                    assert fx["anchor"]["markerId"] in marker_ids, fx["id"]


def test_ai_commands_expected_ops_are_known() -> None:
    known = {
        v["properties"]["op"]["const"]
        for k, v in SCHEMA["definitions"].items()
        if k.startswith("Op") and "op" in v.get("properties", {})
    }
    for c in load_json(FIXTURES / "ai_commands.json")["commands"]:
        assert set(c["expectedOps"]) <= known, c["id"]
