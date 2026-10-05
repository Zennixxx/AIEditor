"""ID по CONTRACT §1: префикс + nanoid(10); ID ассета детерминирован от файла."""

from __future__ import annotations

import hashlib
import re
import secrets
import string
from pathlib import Path

_ALPHABET = string.ascii_letters + string.digits

ASSET_ID_RE = re.compile(r"^ast_[0-9a-f]{16}$")
PROJECT_ID_RE = re.compile(r"^prj_[A-Za-z0-9_-]{1,64}$")


def nanoid(size: int = 10) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(size))


def new_id(prefix: str) -> str:
    return f"{prefix}_{nanoid()}"


def asset_id_for(path: Path) -> str:
    """`ast_` + первые 16 hex sha1("абсолютный путь|размер|mtime").

    mtime — целые наносекунды (`st_mtime_ns`), путь — `Path.resolve()`.
    """
    resolved = path.resolve()
    st = resolved.stat()
    key = f"{resolved}|{st.st_size}|{st.st_mtime_ns}"
    return "ast_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
