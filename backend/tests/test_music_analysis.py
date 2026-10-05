"""Фаза 2: анализ музыки — DSP на синтетике, API, кэш, производительность."""

from __future__ import annotations

import time
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.audio.analysis import ALGO_VERSION, merge_params, params_hash
from app.audio.bass import SR
from app.audio.dsp import analyze_file, analyze_signal
from app.audio.sections import label_sections
from app.audio.stems import demucs_installed
from app.models.gen import MusicAnalysis, MusicAnalysisParamsInput
from tests.conftest import FFMPEG, requires_ffmpeg, wait_until
from tests.synth import click_track
from tests.test_shared_contract import validate

PARAMS: dict[str, Any] = {"bassCutoffHz": 150, "sensitivity": 0.5, "minGapSec": 0.12, "useStems": False}
QUIET_LOUD_QUIET = [(0, 20, 0.15), (40, 60, 0.15)]


def check_invariants(a: dict[str, Any], duration: float) -> None:
    secs = a["sections"]
    assert secs[0]["start"] == 0
    assert secs[-1]["end"] == pytest.approx(duration, abs=0.01)
    for s in secs:
        assert s["start"] < s["end"] and 0 <= s["energy"] <= 1
    for prev, nxt in pairwise(secs):
        assert prev["end"] == nxt["start"]  # отсортированы, не перекрываются, покрывают трек
    for key in ("bass", "onsets"):
        times = [m["t"] for m in a[key]]
        assert times == sorted(times) and all(0 <= m["strength"] <= 1 for m in a[key])
        assert all(0 <= t <= duration for t in times)
    assert a["beats"] == sorted(a["beats"]) and set(a["downbeats"]) <= set(a["beats"])
    assert all(0 <= v <= 1 for v in a["energy"]["values"])
    assert a["energy"]["interval"] == 0.1


# ---------- DSP ----------


def test_click_track_bpm_bass_and_sections() -> None:
    y, hits = click_track(60, 120, QUIET_LOUD_QUIET)
    a = analyze_signal(y, PARAMS)
    check_invariants(a, 60.0)

    assert a["bpm"] == pytest.approx(120, abs=1)
    assert len(a["beats"]) == pytest.approx(len(hits), abs=3)
    assert len(a["downbeats"]) == pytest.approx(len(hits) / 4, abs=2)

    bass = np.array([m["t"] for m in a["bass"]])
    err = np.array([np.abs(bass - h).min() for h in hits])
    assert (err <= 0.015).mean() >= 0.95, f"доля попаданий ±15 мс: {(err <= 0.015).mean():.2f}"

    labels = [(s["label"], s["start"], s["end"]) for s in a["sections"]]
    loud = [s for s in a["sections"] if s["start"] < 30 < s["end"]]
    assert loud and loud[0]["label"] == "drop", labels
    assert max(a["sections"], key=lambda s: s["energy"])["label"] == "drop"
    assert a["sections"][0]["label"] == "intro" and a["sections"][-1]["label"] == "outro"


def test_min_gap_changes_result() -> None:
    y, _ = click_track(20, 120)
    base = analyze_signal(y, PARAMS)
    sparse = analyze_signal(y, {**PARAMS, "minGapSec": 0.9})
    assert len(sparse["bass"]) < len(base["bass"])


def test_label_sections_rules() -> None:
    half = [(0.2, 0.2), (0.3, 0.6), (0.9, 0.9), (0.2, 0.2), (0.9, 0.9), (0.3, 0.3)]
    energies = [0.2, 0.45, 0.9, 0.2, 0.9, 0.3]
    assert label_sections(energies, half) == ["intro", "build", "drop", "break", "drop", "outro"]
    assert label_sections([0.5, 0.5, 0.5], [(0.5, 0.5)] * 3) == ["intro", "verse", "outro"]
    assert label_sections([0.5], [(0.5, 0.5)]) == ["verse"]


def test_params_hash_and_defaults() -> None:
    p = merge_params(None)
    assert (p.bass_cutoff_hz, p.sensitivity, p.min_gap_sec, p.use_stems) == (150, 0.5, 0.12, False)
    p2 = merge_params(MusicAnalysisParamsInput.model_validate({"sensitivity": 0.8}))
    assert p2.sensitivity == 0.8 and p2.bass_cutoff_hz == 150
    assert params_hash(p) == params_hash(
        merge_params(MusicAnalysisParamsInput.model_validate({"bassCutoffHz": 150}))
    )
    assert params_hash(p) != params_hash(p2)
    assert ALGO_VERSION >= 1


# ---------- API ----------


@pytest.fixture(scope="module")
def track_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    y, _ = click_track(60, 120, QUIET_LOUD_QUIET)
    path = tmp_path_factory.mktemp("music") / "track.wav"
    sf.write(path, y, SR, subtype="PCM_16")
    return path


def run_job(client: TestClient, response: Any) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    job_id = response.json()["jobId"]

    def done() -> dict[str, Any] | None:
        j = client.get(f"/api/jobs/{job_id}").json()
        return j if j["status"] in ("done", "failed", "canceled") else None

    return wait_until(done, timeout=180)


def import_track(client: TestClient, path: Path) -> str:
    asset = client.post("/api/assets/import", json={"paths": [str(path)]}).json()["assets"][0]

    def ready() -> dict[str, Any] | None:
        a = client.get(f"/api/assets/{asset['id']}").json()
        return a if a["status"] != "importing" else None

    wait_until(ready)
    return asset["id"]


@requires_ffmpeg
def test_analysis_api_flow_and_cache(client: TestClient, track_wav: Path, settings: Any) -> None:
    aid = import_track(client, track_wav)

    r = client.get(f"/api/analysis/music/{aid}")
    assert r.status_code == 404 and r.json()["error"]["code"] == "analysis_not_found"

    job = run_job(client, client.post(f"/api/analysis/music/{aid}", json={"sensitivity": 0.6}))
    assert job["kind"] == "musicAnalysis" and job["status"] == "done", job
    result = job["result"]
    validate(result, "MusicAnalysis")
    MusicAnalysis.model_validate(result)
    assert result["assetId"] == aid
    assert result["params"] == {"bassCutoffHz": 150, "sensitivity": 0.6, "minGapSec": 0.12, "useStems": False}
    assert result["bpm"] == pytest.approx(120, abs=1)
    check_invariants(result, 60.0)
    assert "stems" not in result

    got = client.get(f"/api/analysis/music/{aid}")
    assert got.status_code == 200 and got.json() == result
    cache = settings.data_dir / "assets" / aid / "analysis" / "music.json"
    assert cache.is_file()

    # те же параметры: из кэша, мгновенно, тот же результат
    t0 = time.monotonic()
    again = run_job(client, client.post(f"/api/analysis/music/{aid}", json={"sensitivity": 0.6}))
    assert again["status"] == "done" and again["result"] == result
    assert time.monotonic() - t0 < 2.0
    assert again["message"] == "Из кэша"

    # другие параметры: пересчёт и новый кэш
    other = run_job(client, client.post(f"/api/analysis/music/{aid}"))
    assert other["status"] == "done" and other["result"]["params"]["sensitivity"] == 0.5
    assert client.get(f"/api/analysis/music/{aid}").json()["params"]["sensitivity"] == 0.5


def test_analysis_errors(client: TestClient) -> None:
    missing = "ast_0000000000000000"
    for method, url in (
        ("get", f"/api/analysis/music/{missing}"),
        ("post", f"/api/analysis/music/{missing}"),
        ("post", f"/api/assets/{missing}/stems"),
    ):
        r = getattr(client, method)(url)
        assert r.status_code == 404 and r.json()["error"]["code"] == "asset_not_found", (method, url)
    assert client.post("/api/analysis/music/bogus").json()["error"]["code"] == "asset_not_found"


@requires_ffmpeg
def test_stems_and_use_stems_need_demucs(client: TestClient, track_wav: Path) -> None:
    if demucs_installed():
        pytest.skip("demucs установлен — 501 не проверить")
    aid = import_track(client, track_wav)
    r = client.post(f"/api/assets/{aid}/stems")
    assert r.status_code == 501 and r.json()["error"]["code"] == "demucs_not_installed"
    r = client.post(f"/api/analysis/music/{aid}", json={"useStems": True})
    assert r.status_code == 501 and r.json()["error"]["code"] == "demucs_not_installed"


@requires_ffmpeg
def test_analysis_rejects_invalid_params(client: TestClient, track_wav: Path) -> None:
    aid = import_track(client, track_wav)
    r = client.post(f"/api/analysis/music/{aid}", json={"sensitivity": 2})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


@requires_ffmpeg
def test_video_without_audio_is_rejected(client: TestClient, media_dir: Path) -> None:
    aid = import_track(client, media_dir / "legacy.avi")  # видео без звука
    r = client.post(f"/api/analysis/music/{aid}")
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_audio"


# ---------- производительность ----------


@requires_ffmpeg
def test_three_minute_track_under_10s(tmp_path: Path) -> None:
    assert FFMPEG is not None
    y, _ = click_track(180, 128, [(0, 45, 0.2), (45, 90, 1.0), (90, 135, 0.4), (135, 180, 1.0)])
    wav = tmp_path / "long.wav"
    sf.write(wav, y, SR, subtype="PCM_16")
    t0 = time.perf_counter()
    a = analyze_file(str(FFMPEG), str(wav), PARAMS)  # декодирование + весь DSP, без стемов
    elapsed = time.perf_counter() - t0
    print(f"3-minute analysis: {elapsed:.2f} s")
    check_invariants(a, 180.0)
    assert a["bpm"] == pytest.approx(128, abs=1.5)
    assert elapsed < 10.0
