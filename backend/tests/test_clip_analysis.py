"""Фаза 3: локальный анализ клипа — энергия движения и склейки."""

from __future__ import annotations

from itertools import pairwise
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.jobs.manager import JobManager
from app.models.gen import ClipAnalysis
from app.video.analysis import build_local_analysis
from app.video.motion import motion_curve, raw_motion
from app.video.scenes import detect_cuts, histogram_distances, shots_from_cuts
from tests.conftest import ffmpeg, requires_ffmpeg, wait_until
from tests.test_music_analysis import import_track
from tests.test_shared_contract import validate

H, W = 90, 160


def flat(value: int, n: int) -> np.ndarray:
    return np.full((n, H, W), value, dtype=np.uint8)


def moving_bar(n: int, step: int = 8) -> np.ndarray:
    frames = np.full((n, H, W), 60, dtype=np.uint8)
    for i in range(n):
        x = (i * step) % (W - 20)
        frames[i, :, x : x + 20] = 200
    return frames


# ---------- чистые функции ----------


def test_static_video_has_zero_motion() -> None:
    assert motion_curve(flat(100, 40)) == [0.0] * 40


def test_motion_is_normalized_and_tracks_movement() -> None:
    frames = np.concatenate([flat(60, 30), moving_bar(30), flat(60, 30)])
    m = motion_curve(frames)
    assert len(m) == 90
    assert all(0.0 <= v <= 1.0 for v in m)
    assert max(m) == pytest.approx(1.0)
    assert np.mean(m[35:55]) > 0.5
    assert np.mean(m[5:25]) == 0.0 and np.mean(m[65:85]) == 0.0


def test_raw_motion_edge_cases() -> None:
    assert raw_motion(flat(0, 0)).size == 0
    assert raw_motion(flat(0, 1)).tolist() == [0.0]
    assert motion_curve(flat(0, 0)) == []


def test_cut_frames_are_not_counted_as_motion() -> None:
    frames = np.concatenate([flat(40, 30), flat(220, 30)])
    cuts = detect_cuts(frames, 10)
    assert cuts == [30]
    assert max(motion_curve(frames, cuts)) == 0.0
    assert max(motion_curve(frames)) > 0  # без учёта склеек скачок виден


def test_detect_cuts_and_shots() -> None:
    frames = np.concatenate([flat(30, 25), flat(120, 25), flat(230, 30)])
    d = histogram_distances(frames)
    assert d[0] == 0 and d[25] == pytest.approx(1.0) and d[24] == 0
    cuts = detect_cuts(frames, 10)
    assert cuts == [25, 50]
    assert shots_from_cuts(cuts, 10, 8.0) == [(0.0, 2.5), (2.5, 5.0), (5.0, 8.0)]


def test_moving_content_inside_shot_is_not_a_cut() -> None:
    assert detect_cuts(moving_bar(60), 10) == []


def test_too_short_shots_are_merged() -> None:
    frames = np.concatenate([flat(30, 20), flat(120, 1), flat(230, 20)])
    cuts = detect_cuts(frames, 10)
    assert len(cuts) == 1  # вспышка в один кадр — не отдельный шот


def test_shots_cover_clip_without_gaps() -> None:
    shots = shots_from_cuts([10, 40], 10, 6.0)
    assert shots[0][0] == 0 and shots[-1][1] == 6.0
    assert all(a[1] == b[0] for a, b in pairwise(shots))
    assert shots_from_cuts([], 10, 3.0) == [(0.0, 3.0)]


def test_local_analysis_is_valid_contract_object() -> None:
    a = build_local_analysis("ast_0123456789abcdef", [20], [0.0, 0.5, 1.0], 3.0)
    dumped = a.model_dump(by_alias=True, exclude_none=True)
    validate(dumped, "ClipAnalysis")
    assert dumped["model"] == "" and dumped["moments"] == []
    assert [s["type"] for s in dumped["shots"]] == ["other", "other"]
    assert dumped["motion"] == {"interval": 0.1, "values": [0.0, 0.5, 1.0]}


# ---------- API ----------


@pytest.fixture(scope="module")
def cuts_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """6 с: 2 с статичный красный → 2 с движущийся testsrc → 2 с статичный синий. Склейки на 2.0 и 4.0."""
    d = tmp_path_factory.mktemp("clip")
    ffmpeg(
        "-f", "lavfi", "-i", "color=c=red:s=320x180:d=2:r=30",
        "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=30",
        "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=30",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", str(d / "cuts.mp4"),
    )  # fmt: skip
    return d / "cuts.mp4"


def job_manager(client: TestClient) -> JobManager:
    return cast(FastAPI, client.app).state.jobs


def get_analysis(client: TestClient, aid: str) -> dict[str, Any]:
    def ready() -> dict[str, Any] | None:
        r = client.get(f"/api/analysis/clip/{aid}")
        return r.json() if r.status_code == 200 else None

    return wait_until(ready, timeout=60)


@requires_ffmpeg
def test_clip_analysis_after_import(client: TestClient, cuts_video: Path, settings: Any) -> None:
    aid = import_track(client, cuts_video)
    result = get_analysis(client, aid)
    validate(result, "ClipAnalysis")
    ClipAnalysis.model_validate(result)

    assert result["assetId"] == aid and result["model"] == "" and result["moments"] == []
    shots = result["shots"]
    assert len(shots) == 3, shots
    assert shots[0]["start"] == 0 and shots[-1]["end"] == pytest.approx(6.0, abs=0.05)
    assert shots[0]["end"] == pytest.approx(2.0, abs=0.15)
    assert shots[1]["end"] == pytest.approx(4.0, abs=0.15)
    assert {s["type"] for s in shots} == {"other"}

    motion = result["motion"]
    assert motion["interval"] == 0.1
    assert len(motion["values"]) == pytest.approx(60, abs=3)
    v = np.array(motion["values"])
    assert v.max() == pytest.approx(1.0) and v.min() >= 0
    assert v[5:15].mean() < 0.1 and v[45:55].mean() < 0.1  # статичные сегменты
    assert v[25:35].mean() > 0.5  # движение

    assert (settings.data_dir / "assets" / aid / "analysis" / "clip.json").is_file()
    assert any(j.kind == "clipAnalysis" and j.status == "done" for j in job_manager(client).list())


@requires_ffmpeg
def test_clip_analysis_errors_and_non_video(client: TestClient, media_dir: Path) -> None:
    r = client.get("/api/analysis/clip/ast_0000000000000000")
    assert r.status_code == 404 and r.json()["error"]["code"] == "asset_not_found"

    aid = import_track(client, media_dir / "tone.wav")
    r = client.get(f"/api/analysis/clip/{aid}")
    assert r.status_code == 404 and r.json()["error"]["code"] == "analysis_not_found"
    assert not any(j.kind == "clipAnalysis" for j in job_manager(client).list())


@requires_ffmpeg
def test_missing_clip_analysis_is_built_on_startup(settings: Any, cuts_video: Path) -> None:
    """Ассеты, импортированные до фазы 3 (нет clip.json), получают анализ при старте."""
    from app.main import create_app

    with TestClient(create_app(settings)) as c:
        aid = import_track(c, cuts_video)
        get_analysis(c, aid)
    cache = settings.data_dir / "assets" / aid / "analysis" / "clip.json"
    cache.unlink()
    with TestClient(create_app(settings)) as c:
        assert len(get_analysis(c, aid)["shots"]) == 3
