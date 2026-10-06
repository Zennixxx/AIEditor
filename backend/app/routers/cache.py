"""Очистка кэша — CONTRACT §8.8."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Query, Request

from app.models.gen import CacheCleanupResult
from app.storage.cache_cleanup import CacheCleaner

router = APIRouter(tags=["cache"])


@router.delete("/cache", response_model=CacheCleanupResult, response_model_exclude_none=True)
async def clean_cache(
    request: Request, older_than_days: int = Query(30, ge=0, alias="olderThanDays")
) -> CacheCleanupResult:
    cleaner: CacheCleaner = request.app.state.cache
    return await asyncio.to_thread(cleaner.run, older_than_days)
