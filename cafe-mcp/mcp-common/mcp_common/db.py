"""asyncpg pool management. DATABASE_URL absent => multi-tenant store disabled
and servers run in single-tenant env-fallback mode."""
from __future__ import annotations

import asyncio
import logging
import os
from urllib.parse import urlparse

logger = logging.getLogger("mcp.db")

_pool = None
_pool_lock = asyncio.Lock()


class DatabaseConnectionError(RuntimeError):
    """Raised when the tenant database URL is missing or unreachable."""


def db_configured() -> bool:
    return bool(os.getenv("DATABASE_URL"))


def _database_target(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or "<unknown-host>"
    port = parsed.port or 5432
    database = (parsed.path or "").lstrip("/") or "<unknown-db>"
    return f"{host}:{port}/{database}"


def _connection_help(url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    hints = [
        "Check that Postgres is running and that DATABASE_URL points to a reachable host and port.",
    ]
    if host.endswith(".railway.internal"):
        hints.append(
            "Railway .internal hosts only work from inside Railway; use the public Railway Postgres URL from your local shell."
        )
    elif host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
        hints.append(
            "For local Docker Postgres, make sure the container is running and the published host port matches DATABASE_URL."
        )
    hints.append("In PowerShell, set it with: $env:DATABASE_URL = 'postgresql://user:password@host:port/dbname'")
    return " ".join(hints)


async def get_pool():
    global _pool
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                import asyncpg
                url = os.getenv("DATABASE_URL")
                if not url:
                    raise DatabaseConnectionError(
                        "DATABASE_URL is not set. In PowerShell, set it with: "
                        "$env:DATABASE_URL = 'postgresql://user:password@host:port/dbname'"
                    )
                try:
                    _pool = await asyncpg.create_pool(url, min_size=1, max_size=5, command_timeout=30)
                except OSError as exc:
                    raise DatabaseConnectionError(
                        f"Could not connect to Postgres at {_database_target(url)}. "
                        f"{_connection_help(url)} Original error: {exc}"
                    ) from None
                logger.info("Postgres pool created")
    return _pool


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
