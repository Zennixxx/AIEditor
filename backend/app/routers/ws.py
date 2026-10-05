from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import SCHEMA_VERSION, VERSION
from app.jobs.events import EventHub, dump
from app.models.gen import WsHello

router = APIRouter(tags=["ws"])


@router.websocket("/ws")
async def events(websocket: WebSocket) -> None:
    hub: EventHub = websocket.app.state.hub
    await websocket.accept()
    queue = hub.subscribe()
    try:
        await websocket.send_json(dump(WsHello(type="hello", version=VERSION, schema_version=SCHEMA_VERSION)))

        async def pump() -> None:
            while True:
                await websocket.send_json(await queue.get())

        async def drain() -> None:
            # Клиент ничего не шлёт; читаем только чтобы заметить отключение.
            with contextlib.suppress(WebSocketDisconnect):
                while True:
                    await websocket.receive_text()

        tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe(queue)
