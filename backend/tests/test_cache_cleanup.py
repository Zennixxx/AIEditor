"""Фаза 8: очистка кэша (CONTRACT §8.8), диск и GPU в /health."""

from __future__ import annotations

import asyncio
import copy
import os
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, rife_bin
from app.jobs.manager import JobContext, JobManager
from app.models.gen import Asset, CacheCleanupResult, Health
from app.storage.assets_repo import AssetsRepo
from app.video.gpu import parse_devices, probe_rife_gpus, tiny_png
from tests.conftest import FIXTURES, load_json
from tests.test_shared_contract import validate

OLD = time.time() - 40 * 86_400


def _asset(asset_id: str, path: Path, parent: str | None = None, status: str = "ready") -> Asset:
    data: dict[str, Any] = {
        "id": asset_id,
        "kind": "video",
        "name": path.name,
        "path": str(path),
        "duration": 4.0,
        "hasAudio": False,
        "codec": "h264",
        "browserDecodable": True,
        "status": status,
        "derived": {},
    }
    if parent:
        data["parent"] = {
            "assetId": parent,
            "kind": "interpolated",
            "factor": 4,
            "sourceIn": 0,
            "sourceOut": 2,
        }
    return Asset.model_validate(data)


def _add(client: TestClient, settings: Settings, asset: Asset, age: float = OLD) -> Path:
    repo: AssetsRepo = client.app.state.assets  # type: ignore[attr-defined]
    repo.save(asset)
    folder = settings.data_dir / "assets" / asset.id
    (folder / "proxy.mp4").write_bytes(b"x" * 1000)
    (folder / "thumbs").mkdir(exist_ok=True)
    (folder / "thumbs" / "0.jpg").write_bytes(b"j" * 10)
    for f in folder.rglob("*"):
        os.utime(f, (age, age))
    return folder


def _save_project_using(client: TestClient, asset: Asset, interpolated: str) -> None:
    project = copy.deepcopy(load_json(FIXTURES / "project.json"))
    clip = next(i for t in project["tracks"] for i in t["items"] if i["type"] == "clip")
    meta = next(a for a in project["assets"] if a["id"] == clip["assetId"])
    project["assets"] = [{**meta, "id": asset.id}]
    for t in project["tracks"]:
        t["items"] = [i for i in t["items"] if i["type"] != "clip" or i is clip]
    clip["assetId"] = asset.id
    clip["interpolatedAssetId"] = interpolated
    project["id"], project["revision"] = "prj_cachetest1", 0
    r = client.put("/api/projects/prj_cachetest1", json=project)
    assert r.status_code == 200, r.text


def test_cleanup_removes_only_old_unused_assets(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"original")
    used = _asset("ast_" + "1" * 16, src)
    derived_used = _asset("ast_" + "2" * 16, tmp_path / "i1.mp4", parent=used.id)
    derived_old = _asset("ast_" + "3" * 16, tmp_path / "i2.mp4", parent=used.id)
    unused_old = _asset("ast_" + "4" * 16, src)
    unused_new = _asset("ast_" + "5" * 16, src)
    importing = _asset("ast_" + "6" * 16, src, status="importing")
    for a in (used, derived_used, derived_old, unused_old, importing):
        _add(client, settings, a)
    _add(client, settings, unused_new, age=time.time())
    _save_project_using(client, used, derived_used.id)

    r = client.delete("/api/cache")
    assert r.status_code == 200, r.text
    body = r.json()
    validate(body, "CacheCleanupResult")
    res = CacheCleanupResult.model_validate(body)
    assert sorted(res.removed_assets) == sorted([derived_old.id, unused_old.id])
    assert res.freed_bytes >= 2 * 1010
    left = {a["id"] for a in client.get("/api/assets").json()}
    assert left == {used.id, derived_used.id, unused_new.id, importing.id}
    assert not (settings.data_dir / "assets" / unused_old.id).exists()
    assert (settings.data_dir / "assets" / used.id / "proxy.mp4").is_file()
    assert src.read_bytes() == b"original"

    r = client.delete("/api/cache", params={"olderThanDays": 0})
    assert r.json()["removedAssets"] == [unused_new.id]


def test_cleanup_removes_upload_copy(client: TestClient, settings: Settings) -> None:
    upload_dir = settings.data_dir / "uploads" / ("a" * 16)
    upload_dir.mkdir(parents=True)
    copy_path = upload_dir / "clip.mp4"
    copy_path.write_bytes(b"u" * 500)
    asset = _asset("ast_" + "7" * 16, copy_path)
    _add(client, settings, asset)
    os.utime(copy_path, (OLD, OLD))
    res = client.delete("/api/cache").json()
    assert res["removedAssets"] == [asset.id]
    assert res["freedBytes"] >= 1510
    assert not upload_dir.exists()


def test_cleanup_skips_assets_with_running_jobs(client: TestClient, settings: Settings) -> None:
    asset = _asset("ast_" + "8" * 16, settings.data_dir / "x.mp4")
    _add(client, settings, asset)
    jobs: JobManager = client.app.state.jobs  # type: ignore[attr-defined]

    async def slow(_: JobContext) -> None:
        await asyncio.sleep(5)

    job = client.portal.call(lambda: _submit(jobs, slow, asset.id))  # type: ignore[union-attr]
    try:
        assert client.delete("/api/cache").json()["removedAssets"] == []
    finally:
        client.portal.call(lambda: _cancel(jobs, job))  # type: ignore[union-attr]


async def _submit(jobs: JobManager, fn: Any, asset_id: str) -> str:
    return jobs.submit("debug", fn, asset_id=asset_id).id


async def _cancel(jobs: JobManager, job_id: str) -> None:
    jobs.cancel(job_id)


def test_cleanup_gemini_cache(client: TestClient, settings: Settings) -> None:
    cache = settings.data_dir / "cache" / "gemini"
    old, new, index = cache / "a.json", cache / "b.json", cache / "files.json"
    for f in (old, new, index):
        f.write_text("{}", encoding="utf-8")
    os.utime(old, (OLD, OLD))
    os.utime(index, (OLD, OLD))
    res = client.delete("/api/cache?olderThanDays=30").json()
    assert res["geminiFiles"] == 1
    assert not old.exists() and new.exists() and index.exists()


@pytest.mark.parametrize("value", ["-1", "1.5", "x"])
def test_cleanup_validates_days(client: TestClient, value: str) -> None:
    r = client.delete(f"/api/cache?olderThanDays={value}")
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_health_reports_disk(client: TestClient, settings: Settings) -> None:
    body = client.get("/api/health").json()
    h = Health.model_validate(body)
    assert h.disk.path == str(settings.data_dir)
    assert 0 < h.disk.free <= h.disk.total
    assert "gpus" not in body


def test_parse_devices() -> None:
    stderr = (
        "[0 NVIDIA GeForce RTX 3060]  queueC=2[8]  queueG=0[16]  queueT=1[2]\n"
        "[0 NVIDIA GeForce RTX 3060]  bugsbn1=0  bugbilz=0\n"
        "[1 Intel(R) UHD Graphics 770]  queueC=0[1]\n"
        "0.png 1.png -> out.png done\n"
    )
    assert parse_devices(stderr) == ["NVIDIA GeForce RTX 3060", "Intel(R) UHD Graphics 770"]
    assert parse_devices("vkCreateInstance failed -9\n") == []
    assert tiny_png().startswith(b"\x89PNG")


RIFE = rife_bin(Settings())


@pytest.mark.skipif(RIFE is None, reason="rife-ncnn-vulkan не найден")
def test_probe_real_rife() -> None:
    assert RIFE is not None
    gpus = probe_rife_gpus(RIFE)
    assert gpus is not None
    assert all(isinstance(g, str) and g for g in gpus)
