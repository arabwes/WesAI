"""Per-tenant cache for API client objects, replacing module-level singletons.

Keyed by the current tenant (or '__env__' in single-tenant fallback mode) so
one tenant's authenticated client/token state can never serve another tenant.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from typing import Callable, Generic, TypeVar

from mcp_common.tenant import maybe_tenant

T = TypeVar("T")


def cache_key() -> str:
    tenant = maybe_tenant()
    return tenant.tenant_id if tenant else "__env__"


class TenantCache(Generic[T]):
    def __init__(self, factory: Callable[[], T], ttl_s: float = 3600.0):
        self._factory = factory
        self._ttl = ttl_s
        self._items: dict[str, tuple[float, T]] = {}
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def get(self) -> T:
        key = cache_key()
        hit = self._items.get(key)
        now = time.monotonic()
        if hit and (now - hit[0]) < self._ttl:
            return hit[1]
        async with self._locks[key]:
            hit = self._items.get(key)
            if hit and (time.monotonic() - hit[0]) < self._ttl:
                return hit[1]
            item = self._factory()
            self._items[key] = (time.monotonic(), item)
            return item

    def get_sync(self) -> T:
        """For synchronous client modules (httpx-based helpers)."""
        key = cache_key()
        hit = self._items.get(key)
        if hit and (time.monotonic() - hit[0]) < self._ttl:
            return hit[1]
        item = self._factory()
        self._items[key] = (time.monotonic(), item)
        return item

    def invalidate(self) -> None:
        self._items.pop(cache_key(), None)
