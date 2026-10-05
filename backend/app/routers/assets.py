"""Ассеты: импорт, загрузка, метаданные и отдача файлов с Range — CONTRACT §3, §8."""

from __future__ import annotations

import contextlib
import hashlib
import mimetypes
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from app.errors import ApiException
from app.ids import ASSET_ID_RE
from app.media.pipeline import DERIVED_FILES, MediaService
from app.models.gen import Asset, ImportRequest, ImportResponse
from app.storage import atomic
from app.storage.assets_repo import AssetsRepo
from app.storage.paths import DataPaths

router = APIRouter(prefix="/assets", tags=["assets"])

UPLOAD_CHUNK = 1 << 20
UPLOAD_FIELDS = ("files[]", "files")
CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".aac": "audio/aac",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json",
}
_UNSAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _media(request: Request) -> MediaService:
    return request.app.state.media


def _repo(request: Request) -> AssetsRepo:
    return request.app.state.assets


def _paths(request: Request) -> DataPaths:
    return request.app.state.paths


def _asset(request: Request, asset_id: str) -> Asset:
    asset = _repo(request).get(asset_id) if ASSET_ID_RE.match(asset_id) else None
    if asset is None:
        raise ApiException(404, "asset_not_found", f"Ассет {asset_id} не найден")
    return asset


def content_type(path: Path) -> str:
    ext = path.suffix.lower()
    return CONTENT_TYPES.get(ext) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _file_response(path: Path, asset_id: str) -> FileResponse:
    if not path.is_file():
        raise ApiException(404, "file_not_found", f"Файл {path.name} ассета {asset_id} ещё не готов")
    # FileResponse сам обрабатывает Range/If-Range: 206 + Content-Range, Accept-Ranges: bytes.
    return FileResponse(path, media_type=content_type(path))


# ---------- импорт ----------


@router.post("/import", response_model=ImportResponse, response_model_exclude_none=True)
async def import_assets(body: ImportRequest, request: Request) -> ImportResponse:
    assets, jobs = await _media(request).import_paths(body.paths)
    return ImportResponse(assets=assets, jobs=jobs)


def _safe_name(filename: str | None) -> str:
    name = _UNSAFE_NAME.sub("_", Path(filename or "").name).strip(" .")
    return name or "upload.bin"


async def _store_upload(upload: UploadFile, uploads: Path) -> Path:
    """Поток на диск с sha1 содержимого: тот же файл → тот же путь → тот же ассет."""
    incoming = uploads / ".incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    tmp = incoming / secrets.token_hex(8)
    digest = hashlib.sha1()
    try:
        with tmp.open("wb") as out:
            while chunk := await upload.read(UPLOAD_CHUNK):
                digest.update(chunk)
                out.write(chunk)
        dst = uploads / digest.hexdigest()[:16] / _safe_name(upload.filename)
        if dst.is_file():
            return dst
        dst.parent.mkdir(parents=True, exist_ok=True)
        atomic.replace(tmp, dst)
        return dst
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        await upload.close()


@router.post("/upload", response_model=ImportResponse, response_model_exclude_none=True)
async def upload_assets(request: Request) -> ImportResponse:
    media = _media(request)
    media.tools()  # 503 до приёма файлов, если ffmpeg нет
    form = await request.form()
    uploads = [f for key in UPLOAD_FIELDS for f in form.getlist(key) if isinstance(f, UploadFile)]
    if not uploads:
        raise ApiException(400, "no_files", "Нет файлов в поле files[]")
    paths = [str(await _store_upload(f, _paths(request).uploads)) for f in uploads]
    assets, jobs = await media.import_paths(paths)
    return ImportResponse(assets=assets, jobs=jobs)


# ---------- метаданные ----------


@router.get("", response_model=list[Asset], response_model_exclude_none=True)
async def list_assets(request: Request) -> list[Asset]:
    return _repo(request).list()


@router.get("/{asset_id}", response_model=Asset, response_model_exclude_none=True)
async def get_asset(asset_id: str, request: Request) -> Asset:
    return _asset(request, asset_id)


# ---------- файлы ----------


@router.get("/{asset_id}/original")
async def get_original(asset_id: str, request: Request) -> FileResponse:
    asset = _asset(request, asset_id)
    return _file_response(Path(asset.path), asset_id)


@router.get("/{asset_id}/thumbs/{n}.jpg")
async def get_thumb_sprite(asset_id: str, n: int, request: Request) -> FileResponse:
    _asset(request, asset_id)
    return _file_response(_paths(request).asset_dir(asset_id) / "thumbs" / f"{n}.jpg", asset_id)


@router.get("/{asset_id}/{name}")
async def get_derived_file(asset_id: str, name: str, request: Request) -> FileResponse:
    _asset(request, asset_id)
    if name not in DERIVED_FILES.values():
        raise ApiException(404, "file_not_found", f"Неизвестный файл ассета: {name}")
    return _file_response(_paths(request).asset_dir(asset_id) / name, asset_id)
