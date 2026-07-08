"""Schema migration runner, shared by scripts/tenant_admin.py and the
server's own startup (so `railway run` is never required — the server
migrates itself on boot when DATABASE_URL is set)."""
from __future__ import annotations

import logging
import pathlib

from mcp_common.db import get_pool

logger = logging.getLogger("mcp.migrate")

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "migrations"


async def migrate(quiet: bool = False) -> list[int]:
    """Apply any migration files not yet recorded in schema_migrations.
    Idempotent — safe to call on every startup. Returns versions applied."""
    log = (lambda *a: None) if quiet else print
    pool = await get_pool()
    try:
        applied = {
            r["version"] for r in await pool.fetch("SELECT version FROM schema_migrations")
        }
    except Exception:
        applied = set()

    newly_applied = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        version = int(path.name.split("_")[0])
        if version in applied:
            continue
        log(f"Applying {path.name}...")
        await pool.execute(path.read_text())
        newly_applied.append(version)
    log("Migrations up to date." if not newly_applied else f"Applied {len(newly_applied)} migration(s).")
    return newly_applied


async def migrate_on_startup() -> None:
    """Best-effort auto-migration at server boot. Logs and re-raises on
    failure — a broken schema should fail loudly, not run silently degraded."""
    try:
        applied = await migrate(quiet=True)
        if applied:
            logger.info("Auto-migration applied version(s): %s", applied)
        else:
            logger.info("Schema is up to date, no migrations needed.")
    except Exception:
        logger.exception("Auto-migration failed — server will not start with a broken schema.")
        raise
