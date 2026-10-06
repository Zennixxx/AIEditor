"""Клиент Gemini — docs/BACKEND.md §7.1.

Остальной код видит только протокол `LLM`: в тестах его заменяет фейк без сети.
Ключ API не логируется и не попадает в кэш (ключ кэша — модель, промпт, хэши файлов, версия промпта).
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import logging
import threading
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, ValidationError

from app.config import Settings
from app.jobs.manager import RESOURCE_LIMITS
from app.models.gen import Asset
from app.storage import atomic
from app.storage.paths import DataPaths

log = logging.getLogger(__name__)

type Tier = Literal["fast", "pro"]
type Sleep = Callable[[float], Awaitable[None]]

FILE_TTL = timedelta(hours=48)
FILE_TTL_MARGIN = timedelta(hours=1)
LONG_VIDEO_SEC = 180.0
MAX_ATTEMPTS = 5
RETRY_BASE_DELAY = 1.0
RETRY_MAX_DELAY = 30.0
REQUEST_TIMEOUT = 180.0
UPLOAD_TIMEOUT = 900.0
ACTIVE_POLL_INTERVAL = 2.0


@dataclass(frozen=True, slots=True)
class TextPart:
    text: str


@dataclass(frozen=True, slots=True)
class FilePart:
    uri: str
    mime_type: str
    content_hash: str
    low_resolution: bool = False


type Part = TextPart | FilePart


class LLMError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class LLM(Protocol):
    def model_name(self, tier: Tier) -> str: ...

    async def generate[T: BaseModel](
        self,
        schema: type[T],
        parts: Sequence[Part],
        *,
        system: str = "",
        tier: Tier = "fast",
        prompt_version: str = "1",
    ) -> T: ...

    async def upload(self, path: Path, mime_type: str, *, low_resolution: bool = False) -> FilePart: ...


def cache_key(
    model: str, schema: type[BaseModel], system: str, parts: Sequence[Part], prompt_version: str
) -> str:
    serial: list[Any] = [model, prompt_version, schema.__name__, system]
    for p in parts:
        if isinstance(p, TextPart):
            serial.append({"text": p.text})
        else:
            serial.append({"file": p.content_hash, "mime": p.mime_type, "low": p.low_resolution})
    return hashlib.sha1(json.dumps(serial, ensure_ascii=False).encode("utf-8")).hexdigest()


def file_hash(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def video_low_resolution(duration: float) -> bool:
    return duration > LONG_VIDEO_SEC


async def upload_video(llm: LLM, paths: DataPaths, asset: Asset) -> FilePart:
    proxy = paths.asset_dir(asset.id) / "proxy.mp4"
    if not proxy.is_file():
        raise LLMError("proxy_missing", f"У ассета {asset.id} ещё нет прокси")
    return await llm.upload(proxy, "video/mp4", low_resolution=video_low_resolution(asset.duration))


class ResponseCache:
    def __init__(self, root: Path) -> None:
        self.root = root

    def get(self, key: str) -> Any | None:
        try:
            return atomic.read_json(self.root / f"{key}.json")
        except (FileNotFoundError, ValueError):
            return None

    def put(self, key: str, value: Any) -> None:
        atomic.write_json(self.root / f"{key}.json", value)


class FileRegistry:
    """`cache/gemini/files.json`: хэш файла → загруженный файл Gemini со сроком жизни."""

    def __init__(self, path: Path, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.path = path
        self.now = now
        self._lock = threading.Lock()

    def _read(self) -> dict[str, Any]:
        try:
            data = atomic.read_json(self.path)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, ValueError):
            return {}

    def get(self, content_hash: str, mime_type: str) -> str | None:
        with self._lock:
            entry = self._read().get(content_hash)
        if not isinstance(entry, dict) or entry.get("mimeType") != mime_type:
            return None
        try:
            expires = datetime.fromisoformat(entry["expiresAt"])
        except (KeyError, TypeError, ValueError):
            return None
        if expires - FILE_TTL_MARGIN <= self.now():
            return None
        uri = entry.get("uri")
        return uri if isinstance(uri, str) else None

    def put(self, content_hash: str, *, uri: str, name: str, mime_type: str, expires_at: datetime) -> None:
        with self._lock:
            data = self._read()
            now = self.now()
            data = {
                k: v for k, v in data.items() if isinstance(v, dict) and _parse_time(v.get("expiresAt")) > now
            }
            data[content_hash] = {
                "uri": uri,
                "name": name,
                "mimeType": mime_type,
                "expiresAt": expires_at.isoformat(),
            }
            atomic.write_json(self.path, data)


def _parse_time(value: Any) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=UTC)


def is_retryable(exc: BaseException) -> bool:
    from google.genai import errors

    if isinstance(exc, errors.APIError):
        return exc.code == 429 or exc.code >= 500
    return isinstance(exc, TimeoutError | httpx.TimeoutException | httpx.TransportError)


async def with_retries[R](
    fn: Callable[[], Awaitable[R]], *, what: str, sleep: Sleep = asyncio.sleep, attempts: int = MAX_ATTEMPTS
) -> R:
    for attempt in range(attempts):
        try:
            return await fn()
        except Exception as exc:
            if not is_retryable(exc) or attempt == attempts - 1:
                raise
            delay = min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * 2**attempt)
            log.warning("Gemini %s: %s, повтор через %.0f с", what, type(exc).__name__, delay)
            await sleep(delay)
    raise AssertionError("unreachable")


def _api_error(exc: Exception) -> LLMError:
    from google.genai import errors

    if isinstance(exc, errors.APIError):
        return LLMError("gemini_failed", f"Gemini вернул ошибку {exc.code}: {exc.status or ''}".strip())
    if isinstance(exc, TimeoutError | httpx.TimeoutException):
        return LLMError("gemini_failed", "Gemini не ответил вовремя")
    return LLMError("gemini_failed", f"Ошибка запроса к Gemini: {type(exc).__name__}")


class GeminiClient:
    def __init__(
        self,
        settings: Settings,
        paths: DataPaths,
        *,
        client: Any = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        if client is None:
            from google import genai

            client = genai.Client(api_key=settings.gemini_api_key)
        self._client = client
        self._models: dict[Tier, str] = {"fast": settings.gemini_model_fast, "pro": settings.gemini_model_pro}
        self._cache = ResponseCache(paths.gemini_cache)
        self._files = FileRegistry(paths.gemini_cache / "files.json")
        self._sleep = sleep
        self._sem = asyncio.Semaphore(RESOURCE_LIMITS["gemini"])

    def model_name(self, tier: Tier) -> str:
        return self._models[tier]

    async def generate[T: BaseModel](
        self,
        schema: type[T],
        parts: Sequence[Part],
        *,
        system: str = "",
        tier: Tier = "fast",
        prompt_version: str = "1",
    ) -> T:
        from google.genai import types

        model = self._models[tier]
        key = cache_key(model, schema, system, parts, prompt_version)
        cached = self._cache.get(key)
        if cached is not None:
            try:
                return schema.model_validate(cached)
            except ValidationError:
                pass

        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text=p.text)
                    if isinstance(p, TextPart)
                    else types.Part.from_uri(file_uri=p.uri, mime_type=p.mime_type)
                    for p in parts
                ],
            )
        ]
        low = any(isinstance(p, FilePart) and p.low_resolution for p in parts)
        config = types.GenerateContentConfig(
            system_instruction=system or None,
            response_mime_type="application/json",
            response_schema=schema,
            media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW if low else None,
        )

        async def call() -> Any:
            async with self._sem:
                return await asyncio.wait_for(
                    self._client.aio.models.generate_content(model=model, contents=contents, config=config),
                    REQUEST_TIMEOUT,
                )

        try:
            resp = await with_retries(call, what=f"generate {model}", sleep=self._sleep)
        except Exception as exc:
            raise _api_error(exc) from exc
        usage = getattr(resp, "usage_metadata", None)
        if usage is not None:
            log.info(
                "Gemini %s %s: токены prompt=%s output=%s thoughts=%s total=%s",
                model,
                schema.__name__,
                usage.prompt_token_count,
                usage.candidates_token_count,
                usage.thoughts_token_count,
                usage.total_token_count,
            )
        result = resp.parsed if isinstance(resp.parsed, schema) else None
        if result is None:
            text = resp.text
            if not text:
                raise LLMError("gemini_empty", "Gemini вернул пустой ответ")
            try:
                result = schema.model_validate_json(text)
            except ValidationError as exc:
                raise LLMError(
                    "gemini_bad_response", f"Ответ Gemini не по схеме: {exc.error_count()} ошибок"
                ) from exc
        self._cache.put(key, result.model_dump(mode="json"))
        return result

    async def upload(self, path: Path, mime_type: str, *, low_resolution: bool = False) -> FilePart:
        content_hash = await asyncio.to_thread(file_hash, path)
        uri = self._files.get(content_hash, mime_type)
        if uri is not None:
            return FilePart(uri, mime_type, content_hash, low_resolution)
        try:
            file = await asyncio.wait_for(self._upload_active(path, mime_type), UPLOAD_TIMEOUT)
        except LLMError:
            raise
        except Exception as exc:
            raise _api_error(exc) from exc
        expires = file.expiration_time or datetime.now(UTC) + FILE_TTL
        self._files.put(content_hash, uri=file.uri, name=file.name, mime_type=mime_type, expires_at=expires)
        log.info("Gemini: загружен %s (%s), действует до %s", path.name, file.name, expires.isoformat())
        return FilePart(file.uri, mime_type, content_hash, low_resolution)

    async def _upload_active(self, path: Path, mime_type: str) -> Any:
        from google.genai import types

        async def upload() -> Any:
            async with self._sem:
                return await self._client.aio.files.upload(
                    file=str(path), config=types.UploadFileConfig(mime_type=mime_type)
                )

        file = await with_retries(upload, what=f"upload {path.name}", sleep=self._sleep)
        while True:
            state = getattr(file.state, "value", file.state)
            if state == "ACTIVE":
                return file
            if state == "FAILED":
                raise LLMError("gemini_upload_failed", f"Gemini не смог обработать файл {path.name}")
            await self._sleep(ACTIVE_POLL_INTERVAL)
            file = await with_retries(
                functools.partial(self._client.aio.files.get, name=file.name),
                what="files.get",
                sleep=self._sleep,
            )


def create_llm(settings: Settings, paths: DataPaths) -> LLM | None:
    if not settings.gemini_api_key:
        return None
    return GeminiClient(settings, paths)
