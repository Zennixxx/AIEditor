from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from google.genai import errors
from pydantic import BaseModel

from app.ai.client import (
    FilePart,
    FileRegistry,
    GeminiClient,
    LLMError,
    TextPart,
    cache_key,
    upload_video,
    video_low_resolution,
)
from app.config import Settings
from app.models.gen import Asset, AssetDerived
from app.storage.paths import DataPaths
from tests.fake_llm import FakeLLM


class Answer(BaseModel):
    value: int
    note: str


def api_error(code: int) -> errors.APIError:
    return errors.APIError(code, {"error": {"code": code, "message": "x", "status": "ERR"}})


class FakeModels:
    def __init__(self, *results: Any) -> None:
        self.results = list(results)
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class FakeFiles:
    def __init__(self, states: list[str]) -> None:
        self.states = states
        self.uploaded: list[str] = []
        self.gets = 0

    async def upload(self, *, file: str, config: Any) -> Any:
        self.uploaded.append(file)
        return self._file(self.states[0])

    async def get(self, *, name: str) -> Any:
        self.gets += 1
        return self._file(self.states[min(self.gets, len(self.states) - 1)])

    def _file(self, state: str) -> Any:
        n = len(self.uploaded)
        return SimpleNamespace(
            name=f"files/f{n}",
            uri=f"https://gemini/files/f{n}",
            state=SimpleNamespace(value=state),
            expiration_time=datetime.now(UTC) + timedelta(hours=48),
        )


def response(parsed: Any = None, text: str = "") -> Any:
    usage = SimpleNamespace(
        prompt_token_count=10, candidates_token_count=5, thoughts_token_count=0, total_token_count=15
    )
    return SimpleNamespace(parsed=parsed, text=text, usage_metadata=usage)


def make_client(
    tmp_path: Path, models: FakeModels, files: FakeFiles | None = None
) -> tuple[GeminiClient, list]:
    sleeps: list[float] = []

    async def sleep(d: float) -> None:
        sleeps.append(d)

    fake = SimpleNamespace(aio=SimpleNamespace(models=models, files=files or FakeFiles(["ACTIVE"])))
    settings = Settings(aieditor_data_dir=tmp_path, gemini_api_key="k", gemini_model_fast="m-fast")
    paths = DataPaths(tmp_path)
    paths.ensure()
    return GeminiClient(settings, paths, client=fake, sleep=sleep), sleeps


async def test_generate_parses_and_caches(tmp_path: Path) -> None:
    models = FakeModels(response(Answer(value=1, note="a")))
    client, _ = make_client(tmp_path, models)
    parts = [TextPart("hello")]
    first = await client.generate(Answer, parts, system="sys")
    second = await client.generate(Answer, parts, system="sys")
    assert first == second == Answer(value=1, note="a")
    assert len(models.calls) == 1
    config = models.calls[0]["config"]
    assert models.calls[0]["model"] == "m-fast"
    assert config.response_mime_type == "application/json"
    assert config.response_schema is Answer
    assert config.system_instruction == "sys"
    assert config.media_resolution is None


async def test_cache_key_depends_on_prompt_version_and_files() -> None:
    base = [TextPart("x"), FilePart("uri1", "video/mp4", "h1")]
    k1 = cache_key("m", Answer, "s", base, "1")
    assert k1 == cache_key("m", Answer, "s", [TextPart("x"), FilePart("uri2", "video/mp4", "h1")], "1")
    assert k1 != cache_key("m", Answer, "s", base, "2")
    assert k1 != cache_key("m", Answer, "s", [TextPart("x"), FilePart("uri1", "video/mp4", "h2")], "1")
    assert k1 != cache_key("m2", Answer, "s", base, "1")


async def test_generate_falls_back_to_text(tmp_path: Path) -> None:
    models = FakeModels(response(None, '{"value": 7, "note": "t"}'))
    client, _ = make_client(tmp_path, models)
    assert await client.generate(Answer, [TextPart("q")]) == Answer(value=7, note="t")


async def test_generate_bad_json_is_llm_error(tmp_path: Path) -> None:
    models = FakeModels(response(None, '{"value": "x"}'))
    client, _ = make_client(tmp_path, models)
    with pytest.raises(LLMError) as exc:
        await client.generate(Answer, [TextPart("q")])
    assert exc.value.code == "gemini_bad_response"


async def test_retries_on_429_and_5xx(tmp_path: Path) -> None:
    models = FakeModels(api_error(429), api_error(503), TimeoutError(), response(Answer(value=2, note="")))
    client, sleeps = make_client(tmp_path, models)
    assert (await client.generate(Answer, [TextPart("q")])).value == 2
    assert sleeps == [1.0, 2.0, 4.0]


async def test_gives_up_after_five_attempts(tmp_path: Path) -> None:
    models = FakeModels(*[api_error(500) for _ in range(5)])
    client, sleeps = make_client(tmp_path, models)
    with pytest.raises(LLMError) as exc:
        await client.generate(Answer, [TextPart("q")])
    assert exc.value.code == "gemini_failed"
    assert len(models.calls) == 5
    assert len(sleeps) == 4


async def test_client_error_is_not_retried(tmp_path: Path) -> None:
    models = FakeModels(api_error(400))
    client, sleeps = make_client(tmp_path, models)
    with pytest.raises(LLMError):
        await client.generate(Answer, [TextPart("q")])
    assert len(models.calls) == 1
    assert sleeps == []


async def test_low_resolution_for_long_video(tmp_path: Path) -> None:
    models = FakeModels(response(Answer(value=3, note="")))
    client, _ = make_client(tmp_path, models)
    await client.generate(Answer, [FilePart("u", "video/mp4", "h", low_resolution=True), TextPart("q")])
    assert models.calls[0]["config"].media_resolution.value == "MEDIA_RESOLUTION_LOW"
    assert video_low_resolution(181) and not video_low_resolution(180)


async def test_upload_waits_for_active_and_reuses(tmp_path: Path) -> None:
    files = FakeFiles(["PROCESSING", "PROCESSING", "ACTIVE"])
    client, sleeps = make_client(tmp_path, FakeModels(), files)
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"video-bytes")
    part = await client.upload(media, "video/mp4")
    assert part.uri.startswith("https://gemini/files/")
    assert files.gets == 2
    assert len(sleeps) == 2
    again = await client.upload(media, "video/mp4", low_resolution=True)
    assert again.uri == part.uri and again.low_resolution
    assert len(files.uploaded) == 1


async def test_upload_failed_state(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path, FakeModels(), FakeFiles(["PROCESSING", "FAILED"]))
    media = tmp_path / "bad.mp4"
    media.write_bytes(b"x")
    with pytest.raises(LLMError) as exc:
        await client.upload(media, "video/mp4")
    assert exc.value.code == "gemini_upload_failed"


def test_file_registry_expiry(tmp_path: Path) -> None:
    now = datetime(2026, 10, 6, 12, tzinfo=UTC)
    reg = FileRegistry(tmp_path / "files.json", now=lambda: now)
    reg.put("h", uri="u", name="files/1", mime_type="video/mp4", expires_at=now + timedelta(hours=48))
    assert reg.get("h", "video/mp4") == "u"
    assert reg.get("h", "audio/mp4") is None
    later = FileRegistry(tmp_path / "files.json", now=lambda: now + timedelta(hours=47, minutes=30))
    assert later.get("h", "video/mp4") is None
    later.put("h2", uri="u2", name="files/2", mime_type="video/mp4", expires_at=now + timedelta(hours=100))
    assert "h" in reg._read()
    gone = FileRegistry(tmp_path / "files.json", now=lambda: now + timedelta(hours=49))
    gone.put("h3", uri="u3", name="files/3", mime_type="video/mp4", expires_at=now + timedelta(hours=100))
    assert set(gone._read()) == {"h2", "h3"}


async def test_upload_video_uses_proxy(tmp_path: Path) -> None:
    paths = DataPaths(tmp_path)
    asset = Asset(
        id="ast_0123456789abcdef", kind="video", name="v.mp4", path="v.mp4", duration=200.0,
        has_audio=False, codec="h264", browser_decodable=True, status="ready", derived=AssetDerived(),
        width=None, height=None, fps=None, parent=None,
    )  # fmt: skip
    llm = FakeLLM()
    with pytest.raises(LLMError):
        await upload_video(llm, paths, asset)
    proxy = paths.asset_dir(asset.id) / "proxy.mp4"
    proxy.parent.mkdir(parents=True)
    proxy.write_bytes(b"p")
    part = await upload_video(llm, paths, asset)
    assert llm.uploads == [proxy]
    assert part.low_resolution
