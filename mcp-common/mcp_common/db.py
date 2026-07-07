"""asyncpg pool management. DATABASE_URL absent => multi-tenant store disabled
and servers run in single-tenant env-fallback mode."""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger("mcp.db")

_pool = None
_pool_lock = asyncio.Lock()


def db_configured() -> bool:
    return bool(os.getenv("DATABASE_URL"))


async def get_pool():
    global _pool
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                import asyncpg
                url = os.environ["DATABASE_URL"]
                _pool = await asyncpg.create_pool(url, min_size=1, max_size=5, command_timeout=30)
                logger.info("Postgres pool created")
    return _pool


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
