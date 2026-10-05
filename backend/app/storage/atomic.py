"""Атомарная запись файлов: временный файл рядом с целевым + os.replace.

Читатель никогда не видит наполовину записанный файл: либо старая версия, либо новая.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

# На Windows os.replace падает с PermissionError, пока целевой файл открыт кем-то ещё
# (например, его в этот момент отдаёт FileResponse). Обычно это доли секунды.
_REPLACE_RETRIES = 20
_REPLACE_DELAY = 0.05


def part_path(path: Path) -> Path:
    """Имя временного файла рядом с целевым; расширение сохраняется (ffmpeg выбирает муксер по нему)."""
    return path.with_name(f"{path.stem}.part-{secrets.token_hex(4)}{path.suffix}")


def replace(src: Path, dst: Path) -> None:
    for attempt in range(_REPLACE_RETRIES):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == _REPLACE_RETRIES - 1:
                raise
            time.sleep(_REPLACE_DELAY)


def replace_dir(src: Path, dst: Path) -> None:
    """Подменить каталог целиком: старый уезжает в сторону и удаляется."""
    old: Path | None = None
    if dst.exists():
        old = dst.with_name(f"{dst.name}.old-{secrets.token_hex(4)}")
        replace(dst, old)
    replace(src, dst)
    if old is not None:
        shutil.rmtree(old, ignore_errors=True)


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = part_path(path)
    try:
        with tmp.open("wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


def write_json(path: Path, obj: Any) -> None:
    write_bytes(path, json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))
