"""WS-хаб: рассылка событий CONTRACT §8 (WsEvent) всем подключённым клиентам."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pydantic import BaseModel

log = logging.getLogger(__name__)

QUEUE_LIMIT = 1000


def dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


class EventHub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_LIMIT)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def publish(self, event: BaseModel) -> None:
        payload = dump(event)
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                log.warning("ws subscriber queue full, dropping event %s", payload.get("type"))
