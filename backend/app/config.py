from __future__ import annotations

import shutil
import sys
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

VERSION = "0.1.0"
SCHEMA_VERSION = 1

BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = BACKEND_DIR.parent
TOOLS_BIN = ROOT_DIR / "tools" / "bin"
EXE = ".exe" if sys.platform == "win32" else ""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    gemini_api_key: str = ""
    gemini_model_fast: str = "gemini-flash-latest"
    gemini_model_pro: str = "gemini-pro-latest"

    aieditor_data_dir: Path = ROOT_DIR / "data"
    aieditor_host: str = "127.0.0.1"
    aieditor_port: int = 8765
    aieditor_debug: bool = False
    aieditor_cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173", "tauri://localhost"]

    ffmpeg_path: Path | None = None
    ffprobe_path: Path | None = None
    rife_path: Path | None = None

    @property
    def data_dir(self) -> Path:
        return self.aieditor_data_dir.resolve()


def _resolve_binary(explicit: Path | None, bundled: Path, name: str) -> Path | None:
    if explicit is not None:
        return explicit if explicit.is_file() else None
    if bundled.is_file():
        return bundled
    found = shutil.which(name)
    return Path(found) if found else None


def ffmpeg_bin(s: Settings) -> Path | None:
    return _resolve_binary(s.ffmpeg_path, TOOLS_BIN / f"ffmpeg{EXE}", "ffmpeg")


def ffprobe_bin(s: Settings) -> Path | None:
    return _resolve_binary(s.ffprobe_path, TOOLS_BIN / f"ffprobe{EXE}", "ffprobe")


def rife_bin(s: Settings) -> Path | None:
    return _resolve_binary(
        s.rife_path, TOOLS_BIN / "rife-ncnn-vulkan" / f"rife-ncnn-vulkan{EXE}", "rife-ncnn-vulkan"
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
