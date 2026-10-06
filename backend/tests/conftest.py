from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import ROOT_DIR, Settings, ffmpeg_bin, ffprobe_bin
from app.main import create_app

SHARED = ROOT_DIR / "shared"
FIXTURES = SHARED / "fixtures"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--gemini", action="store_true", help="живые тесты с Gemini API (нужен GEMINI_API_KEY)")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "gemini: живой запрос к Gemini, только с --gemini")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--gemini"):
        return
    skip = pytest.mark.skip(reason="живой Gemini — только с --gemini")
    for item in items:
        if "gemini" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        aieditor_data_dir=tmp_path / "data", aieditor_debug=True, gemini_api_key="", aieditor_probe_gpu=False
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        yield c


# ffmpeg ищется так же, как в приложении: FFMPEG_PATH/FFPROBE_PATH → tools/bin → PATH.
FFMPEG = ffmpeg_bin(Settings())
FFPROBE = ffprobe_bin(Settings())
requires_ffmpeg = pytest.mark.skipif(
    FFMPEG is None or FFPROBE is None, reason="ffmpeg/ffprobe не найдены (FFMPEG_PATH, FFPROBE_PATH)"
)


def ffmpeg(*args: str) -> None:
    assert FFMPEG is not None
    subprocess.run(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", *args], check=True, capture_output=True
    )


def ffprobe_json(path: Path) -> dict[str, Any]:
    assert FFPROBE is not None
    out = subprocess.run(
        [str(FFPROBE), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        check=True,
        capture_output=True,
    )
    return json.loads(out.stdout)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Синтетические медиа: 5-секундное видео (testsrc + sine), аудио, ProRes-подобный исходник."""
    if FFMPEG is None:
        pytest.skip("ffmpeg не найден")
    d = tmp_path_factory.mktemp("media")
    ffmpeg(
        "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=5:sample_rate=48000",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", "-shortest",
        str(d / "video.mp4"),
    )  # fmt: skip
    ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=220:duration=3:sample_rate=44100",
        "-c:a", "pcm_s16le", str(d / "tone.wav"),
    )  # fmt: skip
    # mpeg4 (Part 2) браузер не декодирует → нужен mezzanine
    ffmpeg(
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25",
        "-c:v", "mpeg4", "-q:v", "5", str(d / "legacy.avi"),
    )  # fmt: skip
    return d


def wait_until[T](fn: Callable[[], T | None], timeout: float = 120.0, step: float = 0.05) -> T:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value is not None:
            return value
        time.sleep(step)
    raise AssertionError(f"не дождались за {timeout} с")
