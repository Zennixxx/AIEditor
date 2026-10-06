from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.client import GeminiClient, LLMError
from app.ai.command import CopilotService, load_ramp_presets
from app.ai.summarize import summarize
from app.ai.timeline import OpsError, filter_markers
from app.ai.validate_ops import DryRun
from app.config import SHARED_DIR, Settings
from app.effects.registry import load_registry
from app.models.gen import (
    AICommandRequest,
    AiCommandsFile,
    MarkerFilter,
    OpsResult,
    Project,
    Selection,
)
from app.models.ops import parse_op
from app.storage.paths import DataPaths
from tests.conftest import FIXTURES, load_json
from tests.fake_llm import FakeLLM

REGISTRY = load_registry(SHARED_DIR)
RAMP_PRESETS = load_ramp_presets(SHARED_DIR)
COMMANDS = AiCommandsFile.model_validate(load_json(FIXTURES / "ai_commands.json"))


def project() -> Project:
    return Project.model_validate(load_json(FIXTURES / COMMANDS.project_fixture))


def service() -> CopilotService:
    return CopilotService(REGISTRY, RAMP_PRESETS, lambda _: None)


def request(message: str, clip_ids: list[str] | None = None, playhead: float = 30.0) -> AICommandRequest:
    return AICommandRequest(
        project=project(),
        selection=Selection(clip_ids=clip_ids or [], marker_ids=[], effect_ids=[]),
        playhead=playhead,
        message=message,
        history=None,
    )


def answer(*ops: dict[str, Any], explanation: str = "Готово.") -> dict[str, Any]:
    return {"ops": list(ops), "explanation": explanation}


SCRIPTED: dict[str, dict[str, Any]] = {
    "shake-drop": answer(
        {
            "op": "applyEffectToMarkers",
            "effect": "shake",
            "filter": {"kinds": ["bass"], "min_strength": 0.6, "section_labels": ["drop"]},
            "target": "newFxTrack",
            "scale_by_strength": True,
        }
    ),
    "flicker-build": answer(
        {
            "op": "applyEffectToMarkers",
            "effect": "flicker",
            "filter": {"kinds": ["bass", "downbeat"], "every": 2, "section_labels": ["build"]},
            "target": "newFxTrack",
        }
    ),
    "velocity-end": answer(
        {"op": "setTimeRemap", "clip_id": "clp_drop000002", "ramp_preset": "fast-slow-fast"},
        {"op": "setTimeRemap", "clip_id": "clp_drop000003", "ramp_preset": "fast-slow-fast"},
    ),
    "cut-to-beats": answer(
        {
            "op": "cutToMarkers",
            "clip_ids": ["clp_drop000001", "clp_drop000002"],
            "filter": {"kinds": ["bass"], "range_start": 30, "range_end": 32.8125},
            "order": "sequential",
        }
    ),
    "remove-weak": answer(
        {
            "op": "removeMarkers",
            "filter": {"kinds": ["bass"], "section_labels": ["intro"], "max_strength": 0.4},
        }
    ),
    "flash-strongest": answer(
        {
            "op": "applyEffectToMarkers",
            "effect": "flash",
            "params": [{"key": "color", "value": "#ffffff"}],
            "filter": {"kinds": ["bass"], "min_strength": 0.85},
            "target": "newFxTrack",
        }
    ),
    "slow-selected": answer({"op": "setTimeRemap", "clip_id": "clp_drop000001", "ramp_preset": "slow-end"}),
    "zoom-punch-downbeats": answer(
        {
            "op": "applyEffectToMarkers",
            "effect": "zoomPunch",
            "filter": {"kinds": ["downbeat"], "range_start": 75, "range_end": 90},
            "target": "newFxTrack",
        }
    ),
    "transition-sections": answer(
        {"op": "addTrack", "track_kind": "fx", "id": "tmp_tr", "name": "Переходы"},
        *[
            {
                "op": "addEffect",
                "target": "track",
                "target_id": "tmp_tr",
                "effect": "glitchTransition",
                "start": t - 0.125,
            }
            for t in (15, 30, 60, 75, 90)
        ],
    ),
    "ambiguous": answer(explanation="Что именно сделать: эффекты на басы, нарезку или speed ramp?"),
}


@pytest.mark.parametrize("cmd", COMMANDS.commands, ids=[c.id for c in COMMANDS.commands])
async def test_fixture_commands_with_fake_llm(cmd: Any) -> None:
    llm = FakeLLM(SCRIPTED[cmd.id])
    req = request(cmd.message, cmd.selection.clip_ids if cmd.selection else None, cmd.playhead or 0)
    result = await service().run(llm, req)
    body = OpsResult.model_validate(result.to_json())
    types = {op.op for op in body.ops}
    assert set(cmd.expected_ops) <= types
    assert not result.warnings
    assert len(llm.calls) == 1
    if not cmd.expected_ops:
        assert body.ops == [] and body.explanation


async def test_prompt_contains_context_and_command() -> None:
    llm = FakeLLM(SCRIPTED["ambiguous"])
    raw = request("Сделай красиво").model_dump(by_alias=True)
    raw["history"] = [{"role": "user", "text": "привет"}, {"role": "assistant", "text": "Привет!"}]
    req = AICommandRequest.model_validate(raw)
    await service().run(llm, req)
    call = llm.calls[0]
    assert "applyEffectToMarkers" in call.system
    assert call.tier == "fast"
    assert "PROJECT:" in call.text and "clp_music00001" in call.text and "glitchTransition" in call.text
    assert "Пользователь: привет" in call.text
    assert call.text.rstrip().endswith("КОМАНДА: Сделай красиво")


async def test_retry_with_errors_then_valid() -> None:
    bad = answer(
        {
            "op": "applyEffectToMarkers",
            "effect": "superShake",
            "filter": {"kinds": ["bass"]},
            "target": "newFxTrack",
        }
    )
    good = answer(
        {
            "op": "applyEffectToMarkers",
            "effect": "shake",
            "filter": {"kinds": ["bass"]},
            "target": "newFxTrack",
        }
    )
    llm = FakeLLM(bad, good)
    result = await service().run(llm, request("шейк"))
    assert [op.op for op in result.ops] == ["applyEffectToMarkers"]
    assert not result.warnings
    assert len(llm.calls) == 2
    retry = llm.calls[1].text
    assert "ОШИБКИ ПРОВЕРКИ" in retry and "superShake" in retry and "ТВОЙ ПРЕДЫДУЩИЙ ОТВЕТ" in retry


async def test_invalid_ops_skipped_after_retry() -> None:
    resp = answer(
        {"op": "addTrack", "track_kind": "fx", "id": "tmp_a"},
        {"op": "addEffect", "target": "track", "target_id": "tmp_a", "effect": "nope", "start": 1},
        {"op": "addEffect", "target": "track", "target_id": "tmp_missing", "effect": "flash", "start": 1},
        {
            "op": "applyEffectToMarkers",
            "effect": "shake",
            "filter": {"section_labels": ["drop"]},
            "target": "newFxTrack",
        },
    )
    llm = FakeLLM(resp, resp)
    result = await service().run(llm, request("x"))
    assert [op.op for op in result.ops] == ["addTrack", "applyEffectToMarkers"]
    assert len(result.warnings) == 2
    assert all(w.startswith("Пропущено") for w in result.warnings)
    assert "unknown_temp_id" in result.warnings[1]


async def test_invariant_violation_rejects_everything() -> None:
    resp = answer({"op": "moveClip", "clip_id": "clp_drop000002", "start": 1.0})
    llm = FakeLLM(resp, resp)
    result = await service().run(llm, request("x"))
    assert result.ops == []
    assert any("перекрывает" in w for w in result.warnings)


async def test_retry_failure_falls_back_to_first_answer() -> None:
    resp = answer(
        {"op": "removeClip", "clip_id": "clp_nope"},
        {"op": "removeClip", "clip_id": "clp_drop000003"},
    )
    llm = FakeLLM(resp, LLMError("gemini_failed", "down"))
    result = await service().run(llm, request("x"))
    assert [op.model_dump(by_alias=True)["clipId"] for op in result.ops] == ["clp_drop000003"]
    assert len(result.warnings) == 1


async def test_param_conversion_and_clamp() -> None:
    llm = FakeLLM(
        answer(
            {
                "op": "applyEffectToMarkers",
                "effect": "shake",
                "params": [
                    {"key": "amount", "value": "999"},
                    {"key": "motionBlur", "value": "false"},
                    {"key": "bogus", "value": "1"},
                ],
                "filter": {"kinds": ["bass"]},
                "target": "newFxTrack",
            }
        )
    )
    result = await service().run(llm, request("x"))
    op = result.to_json()["ops"][0]
    assert op["params"] == {"amount": 300.0, "motionBlur": False}
    assert op["target"] == "newFxTrack"
    assert len(result.warnings) == 2
    assert len(llm.calls) == 1


async def test_clear_time_remap_serializes_null() -> None:
    p = project()
    llm = FakeLLM(
        answer(
            {"op": "setTimeRemap", "clip_id": "clp_drop000001", "ramp_preset": "pulse"},
            {"op": "setTimeRemap", "clip_id": "clp_drop000001", "clear": True},
        )
    )
    req = request("x")
    req.project = p
    result = await service().run(llm, req)
    ops = result.to_json()["ops"]
    assert ops[1] == {"op": "setTimeRemap", "clipId": "clp_drop000001", "timeRemap": None}
    pulse = next(r for r in RAMP_PRESETS if r.id == "pulse")
    assert ops[0]["timeRemap"] == pulse.time_remap.model_dump(mode="json", by_alias=True)


async def test_update_clip_speed_keeps_invariant() -> None:
    llm = FakeLLM(answer({"op": "updateClip", "clip_id": "clp_drop000003", "speed": 0.5}))
    result = await service().run(llm, request("x"))
    patch = result.to_json()["ops"][0]["patch"]
    assert patch == {"speed": 0.5, "duration": pytest.approx(0.9375 * 2)}
    assert not result.warnings


def test_summary_is_compact_and_complete() -> None:
    req = request("x")
    s = summarize(req, REGISTRY, RAMP_PRESETS)
    music = s["music"]
    assert music["clipId"] == "clp_music00001"
    assert music["markerCounts"] == {"bass": 131, "downbeat": 51}
    assert len(music["markers"]) == 182
    assert [x["label"] for x in s["sections"]] == ["intro", "build", "drop", "break", "drop", "outro"]
    assert {e["id"] for e in s["effects"]} == set(REGISTRY.effects)
    assert {r["id"] for r in s["rampPresets"]} >= {"fast-slow-fast", "slow-end"}
    assert s["tracks"][1]["items"][0]["effect"] == "filmGrain"

    sel = summarize(request("x", ["clp_drop000001"]), REGISTRY, RAMP_PRESETS)
    times = [m["t"] for m in sel["music"]["markers"]]
    assert times and all(30 <= t <= 31.875 + 1e-6 for t in times)


def test_filter_markers_semantics() -> None:
    p = project()
    drop = filter_markers(p, MarkerFilter.model_validate({"sectionLabels": ["drop"], "minStrength": 0.6}))
    assert drop and all(30 <= m.t < 60 or 75 <= m.t < 90 for m in drop)
    assert all(m.marker.strength >= 0.6 and m.marker.kind == "bass" for m in drop)
    every = filter_markers(p, MarkerFilter.model_validate({"kinds": ["downbeat"], "every": 2, "offset": 1}))
    downbeats = filter_markers(p, MarkerFilter.model_validate({"kinds": ["downbeat"]}))
    assert [m.t for m in every] == [m.t for m in downbeats[1::2]]
    ranged = filter_markers(p, MarkerFilter.model_validate({"range": {"start": 10, "end": 20}}))
    assert all(10 <= m.t <= 20 for m in ranged)
    with pytest.raises(OpsError):
        filter_markers(p, MarkerFilter.model_validate({"musicClipId": "clp_nope"}))


def test_dry_run_macro_errors() -> None:
    def run(raw: dict[str, Any]) -> str:
        dry = DryRun(project(), REGISTRY)
        with pytest.raises(OpsError) as exc:
            dry.apply(parse_op(raw))
        return exc.value.code

    assert run({"op": "cutToMarkers", "clipIds": ["clp_drop000001"], "order": "sequential",
                "filter": {"range": {"start": 30, "end": 30.2}}}) == "no_slots"  # fmt: skip
    assert run({"op": "cutToMarkers", "clipIds": ["clp_drop000001", "clp_drop000002"], "order": "sequential",
                "filter": {"range": {"start": 30, "end": 40}}}) == "slots_overlap"  # fmt: skip
    assert run({"op": "applyEffectToMarkers", "effect": "shake", "target": {"trackId": "trk_fx00000002"},
                "filter": {"range": {"start": 31, "end": 33}}}) == "slots_overlap"  # fmt: skip
    assert run({"op": "applyEffectToMarkers", "effect": "shake", "target": "clipsUnderMarker",
                "filter": {"range": {"start": 70, "end": 90}}}) == "no_markers"  # fmt: skip
    assert run({"op": "applyEffectToMarkers", "effect": "shake", "target": "newFxTrack",
                "params": {"amount": 1000}, "filter": {}}) == "bad_value"  # fmt: skip
    assert run({"op": "addEffect", "target": {"trackId": "trk_video00001"}, "effect": {"effect": "flash",
                "start": 0, "duration": 1, "params": {}, "envelope": {"attack": 0, "hold": 0, "decay": 0.1,
                "curve": "linear"}, "enabled": True}}) == "incompatible_track"  # fmt: skip
    assert run({"op": "setTimeRemap", "clipId": "clp_drop000001", "timeRemap": {"keyframes": [
        {"u": 0.2, "speed": 1, "ease": "linear"}, {"u": 1, "speed": 1, "ease": "linear"}],
        "fit": "stretch", "frameBlend": False}}) == "bad_time_remap"  # fmt: skip


def test_dry_run_split_and_cut_keep_invariants() -> None:
    dry = DryRun(project(), REGISTRY)
    dry.apply(parse_op({"op": "splitClip", "clipId": "clp_build00001", "at": 20}))
    dry.apply(
        parse_op(
            {
                "op": "setTimeRemap",
                "clipId": "clp_intro00001",
                "timeRemap": RAMP_PRESETS[0].time_remap.model_dump(by_alias=True),
            }
        )
    )
    dry.apply(parse_op({"op": "splitClip", "clipId": "clp_intro00001", "at": 5}))
    dry.apply(
        parse_op(
            {"op": "cutToMarkers", "clipIds": ["clp_drop000001", "clp_drop000002"], "order": "sequential",
             "filter": {"range": {"start": 30, "end": 32.8125}}}
        )
    )  # fmt: skip
    dry.apply(
        parse_op(
            {"op": "applyEffectToMarkers", "effect": "zoomPunch", "target": "clipsUnderMarker",
             "filter": {"range": {"start": 30, "end": 32.8}}}
        )
    )  # fmt: skip
    dry.apply(parse_op({"op": "removeClip", "clipId": "clp_drop000003", "ripple": True}))
    assert dry.finalize() == []
    video = dry.project.tracks[0].items
    assert len(video) == 2 + 2 + 4


@pytest.fixture
def ai_client(settings: Settings) -> Any:
    from app.main import create_app

    with TestClient(create_app(settings)) as c:
        yield c


def test_endpoint_without_key(ai_client: TestClient) -> None:
    res = ai_client.post(
        "/api/ai/command", json=request("x").model_dump(mode="json", by_alias=True, exclude_none=True)
    )
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "gemini_not_configured"


def test_endpoint_with_fake_llm(ai_client: TestClient) -> None:
    body = request("Поставь шейк на сильные басы в дропе").model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    ai_client.app.state.llm = FakeLLM(SCRIPTED["shake-drop"])  # type: ignore[attr-defined]
    res = ai_client.post("/api/ai/command", json=body)
    assert res.status_code == 200
    result = OpsResult.model_validate(res.json())
    assert [op.op for op in result.ops] == ["applyEffectToMarkers"]
    assert "warnings" not in res.json()

    ai_client.app.state.llm = FakeLLM(LLMError("gemini_failed", "Gemini не ответил вовремя"))  # type: ignore[attr-defined]
    res = ai_client.post("/api/ai/command", json=body)
    assert res.status_code == 502
    assert res.json()["error"]["code"] == "gemini_failed"

    res = ai_client.post("/api/ai/command", json={**body, "message": ""})
    assert res.status_code == 422


@pytest.mark.gemini
@pytest.mark.parametrize("cmd", COMMANDS.commands, ids=[c.id for c in COMMANDS.commands])
async def test_fixture_commands_live(cmd: Any, tmp_path: Path) -> None:
    settings = Settings(aieditor_data_dir=tmp_path)
    if not settings.gemini_api_key:
        pytest.skip("GEMINI_API_KEY не задан")
    paths = DataPaths(tmp_path)
    paths.ensure()
    llm = GeminiClient(settings, paths)
    req = request(cmd.message, cmd.selection.clip_ids if cmd.selection else None, cmd.playhead or 0)
    result = await service().run(llm, req)
    types = {op.op for op in result.ops}
    print(f"\n[{cmd.id}] {sorted(types)} | {result.explanation} | warnings={result.warnings}")
    assert set(cmd.expected_ops) <= types
    if not cmd.expected_ops:
        assert not result.ops
