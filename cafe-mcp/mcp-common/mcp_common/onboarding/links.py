"""One-time onboarding link lifecycle.

Raw tokens are returned exactly once at mint time and only their sha256 is
stored, so a database leak cannot recover live links. Lookup is by unique
hash index (constant-time by construction). Links expire (default 7 days)
and die permanently at completion.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime

from mcp_common.db import get_pool


@dataclass(frozen=True)
class OnboardingSession:
    link_id: str
    tenant_id: str
    slug: str
    tenant_name: str
    expires_at: datetime


def _hash(raw: str) -> bytes:
    return hashlib.sha256(raw.encode()).digest()


async def mint_link(slug: str, ttl_days: int = 7) -> str:
    """Create a link for a tenant; returns the raw token ONCE."""
    raw = secrets.token_urlsafe(32)
    pool = await get_pool()
    result = await pool.execute(
        """
        INSERT INTO onboarding_links (tenant_id, token_hash, expires_at)
        SELECT id, $2, now() + make_interval(days => $3) FROM tenants WHERE slug = $1
        """,
        slug, _hash(raw), ttl_days,
    )
    if result.split()[-1] == "0":
        raise ValueError(f"No tenant with slug '{slug}'")
    return raw


async def verify_token(raw: str) -> OnboardingSession | None:
    """Return the session for a live (unexpired, uncompleted) link, else None."""
    if not raw:
        return None
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT l.id, l.expires_at, t.id AS tenant_id, t.slug, t.name
        FROM onboarding_links l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.token_hash = $1
          AND l.completed_at IS NULL
          AND l.expires_at > now()
          AND t.status = 'active'
        """,
        _hash(raw),
    )
    if row is None:
        return None
    return OnboardingSession(
        link_id=str(row["id"]),
        tenant_id=str(row["tenant_id"]),
        slug=row["slug"],
        tenant_name=row["name"],
        expires_at=row["expires_at"],
    )


async def complete(raw: str) -> bool:
    """Mark a link completed (single use). Returns False if already dead."""
    pool = await get_pool()
    result = await pool.execute(
        """
        UPDATE onboarding_links SET completed_at = now()
        WHERE token_hash = $1 AND completed_at IS NULL AND expires_at > now()
        """,
        _hash(raw),
    )
    return result.split()[-1] == "1"
