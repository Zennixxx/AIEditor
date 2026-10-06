from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.ai.client import FilePart, Part, TextPart, Tier

type Scripted = dict[str, Any] | BaseModel | Exception | Callable[[Sequence[Part]], dict[str, Any]]


@dataclass
class Call:
    schema: type[BaseModel]
    parts: list[Part]
    system: str
    tier: Tier

    @property
    def text(self) -> str:
        return "\n".join(p.text for p in self.parts if isinstance(p, TextPart))


class FakeLLM:
    def __init__(self, *responses: Scripted) -> None:
        self.responses = list(responses)
        self.calls: list[Call] = []
        self.uploads: list[Path] = []

    def model_name(self, tier: Tier) -> str:
        return f"fake-{tier}"

    async def generate[T: BaseModel](
        self,
        schema: type[T],
        parts: Sequence[Part],
        *,
        system: str = "",
        tier: Tier = "fast",
        prompt_version: str = "1",
    ) -> T:
        self.calls.append(Call(schema, list(parts), system, tier))
        if not self.responses:
            raise AssertionError("FakeLLM: ответы закончились")
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        if callable(r):
            r = r(parts)
        if isinstance(r, BaseModel):
            r = r.model_dump()
        return schema.model_validate(r)

    async def upload(self, path: Path, mime_type: str, *, low_resolution: bool = False) -> FilePart:
        self.uploads.append(path)
        return FilePart(f"fake://{path.name}", mime_type, "hash", low_resolution)
