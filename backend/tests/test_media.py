"""Фаза 1: импорт медиа, производные файлы, Range-отдача."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.ids import asset_id_for
from app.media.ffprobe import parse_probe
from app.media.thumbs import thumb_interval
from app.media.waveform import peaks_from_pcm
from app.models.gen import Asset, ImportResponse, Thumbs, Waveform
from tests.conftest import ffprobe_json, requires_ffmpeg, wait_until
from tests.test_shared_contract import validate

# ---------- чистые функции (без ffmpeg) ----------


def _probe(video: dict[str, Any] | None = None, audio: dict[str, Any] | None = None, **fmt: Any) -> dict:
    streams = []
    if video is not None:
        streams.append({"codec_type": "video", **video})
    if audio is not None:
        streams.append({"codec_type": "audio", **audio})
    return {
        "streams": streams,
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "5.0", **fmt},
    }


H264 = {"codec_name": "h264", "pix_fmt": "yuv420p", "width": 1920, "height": 1080, "r_frame_rate": "30/1"}


def test_probe_h264_8bit_is_browser_decodable() -> None:
    info = parse_probe(_probe(H264, {"codec_name": "aac"}))
    assert (info.kind, info.codec, info.width, info.height, info.fps) == ("video", "h264", 1920, 1080, 30.0)
    assert info.has_audio and info.browser_decodable and not info.needs_mezzanine


def test_probe_h264_10bit_needs_mezzanine() -> None:
    info = parse_probe(_probe({**H264, "pix_fmt": "yuv420p10le"}))
    assert not info.browser_decodable and info.needs_mezzanine and not info.has_audio


@pytest.mark.parametrize(
    ("codec", "pix_fmt", "decodable", "mezz"),
    [
        ("hevc", "yuv420p", True, False),
        ("hevc", "yuv420p10le", True, True),
        ("vp9", "yuv420p", True, False),
        ("av1", "yuv420p10le", True, False),
        ("prores", "yuv422p10le", False, True),
        ("dnxhd", "yuv422p", False, True),
        ("mpeg4", "yuv420p", False, True),
    ],
)
def test_probe_browser_decodable_rules(codec: str, pix_fmt: str, decodable: bool, mezz: bool) -> None:
    info = parse_probe(_probe({**H264, "codec_name": codec, "pix_fmt": pix_fmt}))
    assert info.browser_decodable is decodable
    assert info.needs_mezzanine is mezz


def test_probe_rotation_swaps_dimensions() -> None:
    rotated = {**H264, "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]}
    info = parse_probe(_probe(rotated))
    assert (info.width, info.height) == (1080, 1920)
    legacy = parse_probe(_probe({**H264, "tags": {"rotate": "270"}}))
    assert (legacy.width, legacy.height) == (1080, 1920)


def test_probe_fps_and_vfr() -> None:
    ntsc = parse_probe(_probe({**H264, "r_frame_rate": "30000/1001", "avg_frame_rate": "30000/1001"}))
    assert ntsc.fps == pytest.approx(29.97) and not ntsc.vfr
    vfr = parse_probe(_probe({**H264, "r_frame_rate": "30/1", "avg_frame_rate": "2400/97"}))
    assert vfr.vfr


def test_probe_audio_and_cover_art() -> None:
    cover = {"codec_name": "mjpeg", "width": 500, "height": 500, "disposition": {"attached_pic": 1}}
    info = parse_probe(_probe(cover, {"codec_name": "mp3"}, format_name="mp3"))
    assert (info.kind, info.codec, info.browser_decodable, info.width) == ("audio", "mp3", True, None)


def test_probe_image() -> None:
    img = {"codec_name": "png", "width": 64, "height": 32}
    info = parse_probe({"streams": [{"codec_type": "video", **img}], "format": {"format_name": "png_pipe"}})
    assert (info.kind, info.duration, info.browser_decodable) == ("image", 0.0, True)


def test_peaks_int8_min_max_pairs() -> None:
    samples = np.array([0, 32767, -32768, 256] + [512] * 256 + [-300], dtype=np.int16)
    assert peaks_from_pcm(samples, 4) == [-128, 127] + [2, 2] * 64 + [-2, -2]


def test_thumb_interval() -> None:
    assert thumb_interval(5) == 1
    assert thumb_interval(600) == 1
    assert thumb_interval(601) == 2
    assert thumb_interval(3600) == 6


# ---------- интеграция с ffmpeg ----------


def _wait_asset(client: TestClient, asset_id: str) -> dict[str, Any]:
    def ready() -> dict[str, Any] | None:
        a = client.get(f"/api/assets/{asset_id}").json()
        return a if a["status"] != "importing" else None

    return wait_until(ready)


def _job_kinds(client: TestClient, body: dict[str, Any]) -> list[str]:
    return [client.get(f"/api/jobs/{j['jobId']}").json()["kind"] for j in body["jobs"]]


def _import(client: TestClient, path: Path) -> dict[str, Any]:
    r = client.post("/api/assets/import", json={"paths": [str(path)]})
    assert r.status_code == 200, r.text
    body = r.json()
    ImportResponse.model_validate(body)
    validate(body, "ImportResponse")
    return body


@requires_ffmpeg
def test_import_video_creates_all_derived(client: TestClient, settings: Any, media_dir: Path) -> None:
    src = media_dir / "video.mp4"
    with client.websocket_connect("/api/ws") as ws:
        ws.receive_json()  # hello
        body = _import(client, src)
        [asset] = body["assets"]
        assert asset["id"] == asset_id_for(src)
        assert asset["status"] == "importing"
        assert (asset["kind"], asset["codec"], asset["width"], asset["height"]) == ("video", "h264", 640, 360)
        assert asset["fps"] == 30 and asset["hasAudio"] and asset["browserDecodable"]
        assert asset["duration"] == pytest.approx(5.0, abs=0.1)
        # mezzanine не нужен; audio.m4a — отдельная задача kind "audio" (CONTRACT v1.2)
        assert _job_kinds(client, body) == ["proxy", "thumbs", "audio", "waveform"]

        asset_events: list[dict[str, Any]] = []
        job_events: dict[str, list[dict[str, Any]]] = {}
        while True:
            msg = ws.receive_json()
            if msg["type"] == "job":
                validate(msg, "WsJob")
                job_events.setdefault(msg["job"]["kind"], []).append(msg["job"])
            if msg["type"] == "asset":
                validate(msg, "WsAsset")
                asset_events.append(msg["asset"])
                if msg["asset"]["status"] != "importing":
                    break

    final = _wait_asset(client, asset["id"])
    assert final["status"] == "ready", final
    Asset.model_validate(final)
    validate(final, "Asset")
    aid = asset["id"]
    assert final["derived"] == {
        "proxy": f"/api/assets/{aid}/proxy.mp4",
        "thumbs": f"/api/assets/{aid}/thumbs.json",
        "audio": f"/api/assets/{aid}/audio.m4a",
        "waveform": f"/api/assets/{aid}/waveform.json",
    }
    # событие asset на каждый новый производный файл
    seen = [set(e["derived"]) for e in asset_events]
    for key in ("proxy", "thumbs", "audio", "waveform"):
        assert any(key in s for s in seen), key
    # WS job: у каждого шага цепочки есть событие done, задачи kind "import" нет
    assert set(job_events) == {"proxy", "thumbs", "audio", "waveform"}
    for kind, events in job_events.items():
        assert events[-1]["status"] == "done", kind
        assert all(e["assetId"] == aid for e in events)

    for job in body["jobs"]:
        j = client.get(f"/api/jobs/{job['jobId']}").json()
        assert j["status"] == "done" and j["progress"] == 1, j

    # прокси: 360p (не апскейлим), H.264, GOP без B-кадров, со звуком
    proxy_file = settings.data_dir / "assets" / aid / "proxy.mp4"
    probe = ffprobe_json(proxy_file)
    v = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert (v["codec_name"], v["height"], v["pix_fmt"]) == ("h264", 360, "yuv420p")
    assert v.get("has_b_frames", 0) == 0
    assert any(s["codec_type"] == "audio" for s in probe["streams"])

    thumbs = client.get(final["derived"]["thumbs"]).json()
    Thumbs.model_validate(thumbs)
    validate(thumbs, "Thumbs")
    assert thumbs["interval"] == 1 and (thumbs["columns"], thumbs["rows"]) == (10, 10)
    assert (thumbs["tileWidth"], thumbs["tileHeight"]) == (160, 90)
    assert 5 <= thumbs["count"] <= 6
    assert thumbs["sprites"] == [f"/api/assets/{aid}/thumbs/0.jpg"]
    sprite = client.get(thumbs["sprites"][0])
    assert sprite.status_code == 200 and sprite.headers["content-type"] == "image/jpeg"
    atlas = ffprobe_json(settings.data_dir / "assets" / aid / "thumbs" / "0.jpg")["streams"][0]
    assert (atlas["width"], atlas["height"]) == (1600, 900)

    wf = client.get(final["derived"]["waveform"]).json()
    Waveform.model_validate(wf)
    validate(wf, "Waveform")
    assert (wf["sampleRate"], wf["samplesPerPeak"], wf["channels"]) == (22050, 256, 1)
    assert len(wf["peaks"]) == pytest.approx(2 * 5 * 22050 / 256, rel=0.05)
    assert max(wf["peaks"]) >= 10  # синус lavfi (амплитуда 1/8), не тишина

    # Range → 206
    size = proxy_file.stat().st_size
    r = client.get(final["derived"]["proxy"], headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 0-99/{size}"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "video/mp4"
    assert len(r.content) == 100
    full = client.get(final["derived"]["proxy"])
    assert full.status_code == 200 and len(full.content) == size
    assert full.headers["accept-ranges"] == "bytes"
    tail = client.get(final["derived"]["audio"], headers={"Range": "bytes=-10"})
    assert tail.status_code == 206 and len(tail.content) == 10
    assert tail.headers["content-type"] == "audio/mp4"
    orig = client.get(f"/api/assets/{aid}/original", headers={"Range": "bytes=10-19"})
    assert orig.status_code == 206 and orig.content == src.read_bytes()[10:20]

    # повторный импорт — тот же ассет, без новых задач
    again = _import(client, src)
    assert [a["id"] for a in again["assets"]] == [aid]
    assert again["assets"][0]["status"] == "ready"
    assert again["jobs"] == []

    listed = client.get("/api/assets").json()
    assert [a["id"] for a in listed] == [aid]
    validate(listed[0], "Asset")


@requires_ffmpeg
def test_import_audio(client: TestClient, media_dir: Path) -> None:
    body = _import(client, media_dir / "tone.wav")
    [asset] = body["assets"]
    assert (asset["kind"], asset["codec"], asset["hasAudio"]) == ("audio", "pcm_s16le", True)
    assert "width" not in asset and "fps" not in asset
    assert _job_kinds(client, body) == ["audio", "waveform"]
    final = _wait_asset(client, asset["id"])
    assert final["status"] == "ready"
    validate(final, "Asset")
    assert set(final["derived"]) == {"audio", "waveform"}
    wf = client.get(final["derived"]["waveform"]).json()
    assert len(wf["peaks"]) == pytest.approx(2 * 3 * 22050 / 256, rel=0.05)
    r = client.get(final["derived"]["audio"], headers={"Range": "bytes=0-0"})
    assert r.status_code == 206 and len(r.content) == 1


@requires_ffmpeg
def test_non_browser_codec_gets_mezzanine(client: TestClient, settings: Any, media_dir: Path) -> None:
    body = _import(client, media_dir / "legacy.avi")
    [asset] = body["assets"]
    assert asset["codec"] == "mpeg4" and asset["browserDecodable"] is False and asset["hasAudio"] is False
    assert _job_kinds(client, body) == ["proxy", "thumbs", "mezzanine"]
    final = _wait_asset(client, asset["id"])
    assert final["status"] == "ready"
    assert set(final["derived"]) == {"proxy", "thumbs", "mezzanine"}
    mezz = ffprobe_json(settings.data_dir / "assets" / asset["id"] / "mezzanine.mp4")["streams"][0]
    assert (mezz["codec_name"], mezz["width"], mezz["height"], mezz["pix_fmt"]) == (
        "h264",
        320,
        240,
        "yuv420p",
    )


@requires_ffmpeg
def test_upload_streams_to_disk_and_dedupes(client: TestClient, settings: Any, media_dir: Path) -> None:
    data = (media_dir / "tone.wav").read_bytes()
    r = client.post("/api/assets/upload", files=[("files[]", ("my tone.wav", data, "audio/wav"))])
    assert r.status_code == 200, r.text
    validate(r.json(), "ImportResponse")
    [asset] = r.json()["assets"]
    stored = Path(asset["path"])
    assert stored.is_relative_to(settings.data_dir / "uploads")
    assert stored.name == "my tone.wav" and stored.read_bytes() == data
    _wait_asset(client, asset["id"])

    again = client.post("/api/assets/upload", files=[("files", ("my tone.wav", data, "audio/wav"))])
    assert [a["id"] for a in again.json()["assets"]] == [asset["id"]]
    assert again.json()["jobs"] == []


def test_upload_without_files(client: TestClient) -> None:
    if client.get("/api/health").json()["ffmpeg"] is False:
        pytest.skip("без ffmpeg upload отвечает 503")
    r = client.post("/api/assets/upload", data={"x": "1"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "no_files"


@requires_ffmpeg
def test_import_errors(client: TestClient, tmp_path: Path) -> None:
    r = client.post("/api/assets/import", json={"paths": [str(tmp_path / "nope.mp4")]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "file_not_found"
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"not a video at all")
    r = client.post("/api/assets/import", json={"paths": [str(junk)]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unsupported_media"
    assert client.get("/api/assets").json() == []


def test_unknown_asset_and_file(client: TestClient) -> None:
    for url in (
        "/api/assets/ast_0000000000000000",
        "/api/assets/../x",
        "/api/assets/ast_0000000000000000/proxy.mp4",
    ):
        r = client.get(url)
        assert r.status_code == 404
    assert client.get("/api/assets/ast_0000000000000000").json()["error"]["code"] == "asset_not_found"
