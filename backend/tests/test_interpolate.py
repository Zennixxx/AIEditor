from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, rife_bin
from app.errors import ApiException
from app.main import create_app
from app.models.gen import Asset, AssetDerived
from app.video.interpolate import FrameRange, derived_id, frame_range, output_count, output_rate
from tests.conftest import FFMPEG, FFPROBE, ffmpeg, ffprobe_json, requires_ffmpeg, wait_until
from tests.test_music_analysis import import_track, run_job
from tests.test_shared_contract import validate


def _asset(duration: float = 2.0, fps: float | None = 30.0) -> Asset:
    return Asset(
        id="ast_0000000000000001",
        kind="video",
        name="a.mp4",
        path="a.mp4",
        duration=duration,
        fps=fps,
        has_audio=False,
        codec="h264",
        browser_decodable=True,
        status="ready",
        derived=AssetDerived(),
    )


def test_frame_range_quantizes_to_source_frames() -> None:
    fr = frame_range(_asset(), 0.51, 1.49)
    assert (fr.first, fr.last, fr.fps) == (15, 45, 30.0)
    assert frame_range(_asset(), 0.5, 1.5).first == 15
    assert frame_range(_asset(), 0.5, 1.5).last == 45
    clipped = frame_range(_asset(), -0.1, 5.0)
    assert (clipped.first, clipped.last) == (0, 59)
    assert frame_range(_asset(fps=None), 0, 1).fps == 30.0


@pytest.mark.parametrize(("lo", "hi"), [(2.5, 3.0), (1.0, 1.0), (1.0, 0.5)])
def test_frame_range_rejects_empty(lo: float, hi: float) -> None:
    with pytest.raises(ApiException) as exc:
        frame_range(_asset(), lo, hi)
    assert exc.value.code == "bad_range"


def test_derived_id_and_counts() -> None:
    fr = FrameRange(15, 45, 30.0)
    a = derived_id("ast_0000000000000001", fr, 4)
    assert a == derived_id("ast_0000000000000001", fr, 4)
    assert a != derived_id("ast_0000000000000001", fr, 2)
    assert a.startswith("ast_") and len(a) == 20
    assert output_count(fr, 4) == 121
    assert output_rate(29.97, 4) == pytest.approx(119.88, abs=1e-3)


def _gray_video(path: Path, seconds: float = 2.0, fps: int = 30) -> Path:
    ffmpeg(
        "-f", "lavfi", "-i", f"nullsrc=s=96x64:r={fps}:d={seconds},geq=lum='20+N*3':cb=128:cr=128",
        "-c:v", "libx264", "-crf", "0", "-g", "10", "-bf", "0", "-pix_fmt", "yuv420p", str(path),
    )  # fmt: skip
    return path


def _luma_frames(path: Path) -> np.ndarray:
    assert FFMPEG is not None
    out = subprocess.run(
        [
            str(FFMPEG),
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            "scale=96:64,format=gray",
            "-f",
            "rawvideo",
            "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    frames = np.frombuffer(out, dtype=np.uint8).reshape(-1, 64, 96)
    return frames[:, 32, 48].astype(int)


def _pts(path: Path) -> list[float]:
    assert FFPROBE is not None
    out = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "v",
         "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout  # fmt: skip
    return sorted(float(x) for x in out.split())


@pytest.fixture(scope="module")
def rife_works(tmp_path_factory: pytest.TempPathFactory) -> bool:
    rife = rife_bin(Settings())
    if rife is None or FFMPEG is None:
        return False
    d = tmp_path_factory.mktemp("rife")
    (d / "in").mkdir()
    (d / "out").mkdir()
    for i in (1, 2):
        ffmpeg("-f", "lavfi", "-i", "color=c=gray:s=64x64", "-frames:v", "1", str(d / "in" / f"{i:08d}.png"))
    res = subprocess.run(
        [
            str(rife),
            "-i",
            str(d / "in"),
            "-o",
            str(d / "out"),
            "-m",
            str(rife.parent / "rife-v4.6"),
            "-n",
            "4",
        ],
        capture_output=True,
        check=False,
    )
    return res.returncode == 0 and len(list((d / "out").glob("*.png"))) == 4


@pytest.fixture(scope="module")
def gray_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if FFMPEG is None:
        pytest.skip("ffmpeg не найден")
    return _gray_video(tmp_path_factory.mktemp("interp") / "gray.mp4")


def _check_derived(result: dict[str, Any], parent_id: str, source_in: float, factor: int) -> Asset:
    validate(result, "Asset")
    asset = Asset.model_validate(result)
    assert asset.parent is not None and asset.parent.asset_id == parent_id
    assert asset.parent.factor == factor
    assert asset.parent.source_in == pytest.approx(source_in)
    assert asset.fps == pytest.approx(30 * factor)
    assert asset.has_audio is False and asset.status == "ready"
    assert asset.derived.proxy == f"/api/assets/{asset.id}/proxy.mp4"
    return asset


@requires_ffmpeg
def test_interpolate_one_second_factor_4(client: TestClient, gray_video: Path, rife_works: bool) -> None:
    aid = import_track(client, gray_video)
    job = run_job(
        client,
        client.post(f"/api/assets/{aid}/interpolate", json={"sourceIn": 0.5, "sourceOut": 1.5, "factor": 4}),
    )
    assert job["kind"] == "interpolate" and job["status"] == "done", job
    asset = _check_derived(job["result"], aid, 0.5, 4)
    assert asset.parent is not None and asset.parent.quality == ("rife" if rife_works else "fallback")
    assert asset.parent.source_out == pytest.approx(1.5)

    original = Path(asset.path)
    info = ffprobe_json(original)
    stream = info["streams"][0]
    assert float(stream["start_time"]) == pytest.approx(0.5, abs=1e-3)
    pts = _pts(original)
    assert len(pts) == 121
    assert pts[0] == pytest.approx(0.5, abs=1e-3)
    assert pts[-1] - pts[0] == pytest.approx(1.0, abs=1 / 120)
    assert np.diff(pts) == pytest.approx(1 / 120, abs=1e-3)

    luma, src = _luma_frames(original), _luma_frames(gray_video)
    assert luma[0] == pytest.approx(src[15], abs=2)
    assert luma[40] == pytest.approx(src[25], abs=2)
    assert luma[-1] == pytest.approx(src[45], abs=2)

    proxy = client.get(f"/api/assets/{asset.id}/proxy.mp4", headers={"Range": "bytes=0-99"})
    assert proxy.status_code == 206
    assert _pts(original)[0] == pytest.approx(_pts(original.with_name("proxy.mp4"))[0], abs=1e-3)
    assert client.get(f"/api/assets/{asset.id}/original", headers={"Range": "bytes=0-9"}).status_code == 206

    listed = {a["id"] for a in client.get("/api/assets").json()}
    assert asset.id in listed
    assert not (original.parent / ".work").exists()

    again = run_job(
        client,
        client.post(f"/api/assets/{aid}/interpolate", json={"sourceIn": 0.7, "sourceOut": 1.2, "factor": 4}),
    )
    assert again["status"] == "done" and again["result"]["id"] == asset.id
    other = run_job(
        client,
        client.post(f"/api/assets/{aid}/interpolate", json={"sourceIn": 0.7, "sourceOut": 1.2, "factor": 2}),
    )
    assert other["status"] == "done" and other["result"]["id"] != asset.id


@requires_ffmpeg
def test_interpolate_fallback_without_rife(tmp_path: Path, gray_video: Path) -> None:
    settings = Settings(aieditor_data_dir=tmp_path / "data", rife_path=tmp_path / "no-rife.exe")
    with TestClient(create_app(settings)) as client:
        aid = import_track(client, gray_video)
        job = run_job(
            client,
            client.post(
                f"/api/assets/{aid}/interpolate", json={"sourceIn": 0.0, "sourceOut": 1.0, "factor": 2}
            ),
        )
        assert job["status"] == "done", job
        asset = _check_derived(job["result"], aid, 0.0, 2)
        assert asset.parent is not None and asset.parent.quality == "fallback"
        pts = _pts(Path(asset.path))
        assert len(pts) == 61
        assert pts[0] == pytest.approx(0.0, abs=1e-3)
        luma, src = _luma_frames(Path(asset.path)), _luma_frames(gray_video)
        assert luma[0] == pytest.approx(src[0], abs=2)
        assert luma[20] == pytest.approx(src[10], abs=2)


@requires_ffmpeg
def test_interpolate_cancel_cleans_up(tmp_path: Path) -> None:
    src = tmp_path / "long.mp4"
    ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=6",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(src),
    )  # fmt: skip
    settings = Settings(aieditor_data_dir=tmp_path / "data", rife_path=tmp_path / "no-rife.exe")
    with TestClient(create_app(settings)) as client:
        aid = import_track(client, src)
        r = client.post(f"/api/assets/{aid}/interpolate", json={"sourceIn": 0, "sourceOut": 6, "factor": 16})
        job_id = r.json()["jobId"]

        def running() -> bool | None:
            return True if client.get(f"/api/jobs/{job_id}").json()["progress"] > 0.02 else None

        wait_until(running, timeout=60)
        assert client.delete(f"/api/jobs/{job_id}").status_code == 200

        def finished() -> dict[str, Any] | None:
            j = client.get(f"/api/jobs/{job_id}").json()
            return j if j["status"] != "running" else None

        assert wait_until(finished)["status"] == "canceled"
        dirs = [d for d in (tmp_path / "data" / "assets").iterdir() if d.name != aid]

        def cleaned() -> bool | None:
            return True if not any((d / ".work").exists() for d in dirs) else None

        wait_until(cleaned, timeout=20)
        assert not any((d / "meta.json").exists() for d in dirs)


@requires_ffmpeg
def test_interpolate_errors(client: TestClient, gray_video: Path, media_dir: Path) -> None:
    r = client.post(
        "/api/assets/ast_0123456789abcdef/interpolate", json={"sourceIn": 0, "sourceOut": 1, "factor": 2}
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "asset_not_found"

    audio = import_track(client, media_dir / "tone.wav")
    r = client.post(f"/api/assets/{audio}/interpolate", json={"sourceIn": 0, "sourceOut": 1, "factor": 2})
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_video"

    aid = import_track(client, gray_video)
    r = client.post(f"/api/assets/{aid}/interpolate", json={"sourceIn": 3, "sourceOut": 4, "factor": 2})
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_range"
    r = client.post(f"/api/assets/{aid}/interpolate", json={"sourceIn": 0, "sourceOut": 1, "factor": 3})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
