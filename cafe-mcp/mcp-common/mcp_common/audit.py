"""Fire-and-forget audit logging of tool invocations to Postgres.

A bounded in-memory queue decouples tool latency from DB writes; if the DB is
down or the queue is full, audit rows are dropped with a server-side warning
rather than failing the tool call.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging

from mcp_common.db import db_configured, get_pool
from mcp_common.tenant import maybe_tenant

logger = logging.getLogger("mcp.audit")

_queue: asyncio.Queue | None = None
_writer_task: asyncio.Task | None = None
_SERVER_NAME = "unknown"

_REDACT_KEYS = {"token", "secret", "password", "passcode", "key", "authorization"}
_MAX_SUMMARY_LEN = 500


def configure(server_name: str) -> None:
    global _SERVER_NAME
    _SERVER_NAME = server_name


def _redact(args: dict) -> dict:
    out = {}
    for k, v in args.items():
        if any(s in k.lower() for s in _REDACT_KEYS):
            out[k] = "[redacted]"
        elif isinstance(v, str) and len(v) > 100:
            out[k] = v[:100] + "…"
        else:
            out[k] = v
    return out


async def _writer():
    pool = await get_pool()
    while True:
        row = await _queue.get()
        try:
            await pool.execute(
                """
                INSERT INTO audit_log (server, tenant_id, api_key_id, tool, args_digest,
                                       args_summary, outcome, correlation_id, latency_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                *row,
            )
        except Exception as e:
            logger.warning("audit write failed: %r", e)
        finally:
            _queue.task_done()


async def record(tool: str, args: dict, outcome: str,
                 correlation_id: str | None = None, latency_ms: int | None = None) -> None:
    if not db_configured():
        return
    global _queue, _writer_task
    if _queue is None:
        _queue = asyncio.Queue(maxsize=1000)
        _writer_task = asyncio.create_task(_writer())

    tenant = maybe_tenant()
    canonical = json.dumps(args, sort_keys=True, default=str)
    summary = json.dumps(_redact(args), default=str)[:_MAX_SUMMARY_LEN]
    row = (
        _SERVER_NAME,
        tenant.tenant_id if tenant else None,
        tenant.api_key_id if tenant else None,
        tool,
        hashlib.sha256(canonical.encode()).hexdigest()[:16],
        summary,
        outcome,
        correlation_id,
        latency_ms,
    )
    try:
        _queue.put_nowait(row)
    except asyncio.QueueFull:
        logger.warning("audit queue full; dropping row for tool=%s", tool)


async def audit_denied(tool: str, scope: str) -> None:
    await record(tool, {"required_scope": scope}, "denied")
