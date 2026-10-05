from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import ROOT_DIR, Settings
from app.main import create_app

SHARED = ROOT_DIR / "shared"
FIXTURES = SHARED / "fixtures"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(aieditor_data_dir=tmp_path / "data", aieditor_debug=True, gemini_api_key="")


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        yield c
