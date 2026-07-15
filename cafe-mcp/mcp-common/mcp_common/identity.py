"""Google/Facebook sign-in identities and portal sessions — the persistent
login mechanism for returning tenants. No passwords, no pasted API keys:
a tenant proves who they are by signing into the same Google/Facebook
account already linked to their tenant (as a side effect of connecting
those services during onboarding), and gets an opaque session cookie.

Mirrors the hashing conventions already used elsewhere in this package
(mcp_common.store: raw secrets are returned once, only their sha256 is
persisted; lookups are by unique hash index).
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime

from mcp_common.db import get_pool

SESSION_TTL_HOURS = 12


@dataclass(frozen=True)
class TenantIdentitySession:
    tenant_id: str
    slug: str
    tenant_name: str
    identity_id: str
    email: str | None


def _hash(raw: str) -> bytes:
    return hashlib.sha256(raw.encode()).digest()


async def link_identity(tenant_id: str, provider: str, provider_user_id: str,
                        email: str | None) -> None:
    """Associate a Google/Facebook identity with a tenant. Called as a side
    effect of the existing (already token-gated) onboarding connect flows —
    never in response to an unauthenticated request, so an attacker cannot
    link their own identity to someone else's tenant."""
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO tenant_identities (tenant_id, provider, provider_user_id, email)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (provider, provider_user_id)
        DO UPDATE SET tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email
        """,
        tenant_id, provider, provider_user_id, email,
    )


async def find_tenant_by_identity(provider: str, provider_user_id: str) -> TenantIdentitySession | None:
    """Look up which tenant (if any) a Google/Facebook identity belongs to.
    Returns None for unrecognized identities — callers must show a generic
    "not recognized" message, not distinguish this from other failures."""
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT i.id AS identity_id, i.email, t.id AS tenant_id, t.slug, t.name, t.status
        FROM tenant_identities i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.provider = $1 AND i.provider_user_id = $2
        """,
        provider, provider_user_id,
    )
    if row is None or row["status"] != "active":
        return None
    await pool.execute(
        "UPDATE tenant_identities SET last_login_at = now() WHERE id = $1", row["identity_id"]
    )
    return TenantIdentitySession(
        tenant_id=str(row["tenant_id"]), slug=row["slug"], tenant_name=row["name"],
        identity_id=str(row["identity_id"]), email=row["email"],
    )


async def create_session(tenant_id: str, identity_id: str, user_agent: str = "", ip: str = "") -> str:
    """Issue a new portal session; returns the raw cookie value ONCE."""
    raw = secrets.token_urlsafe(32)
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO portal_sessions (tenant_id, identity_id, session_hash, expires_at, user_agent, ip)
        VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)
        """,
        tenant_id, identity_id, _hash(raw), SESSION_TTL_HOURS, user_agent[:300], ip[:64],
    )
    return raw


async def verify_session(raw: str) -> TenantIdentitySession | None:
    if not raw:
        return None
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT s.tenant_id, s.identity_id, i.email, t.slug, t.name, t.status
        FROM portal_sessions s
        JOIN tenant_identities i ON i.id = s.identity_id
        JOIN tenants t ON t.id = s.tenant_id
        WHERE s.session_hash = $1 AND s.expires_at > now()
        """,
        _hash(raw),
    )
    if row is None or row["status"] != "active":
        return None
    return TenantIdentitySession(
        tenant_id=str(row["tenant_id"]), slug=row["slug"], tenant_name=row["name"],
        identity_id=str(row["identity_id"]), email=row["email"],
    )


async def revoke_session(raw: str) -> None:
    if not raw:
        return
    pool = await get_pool()
    await pool.execute("DELETE FROM portal_sessions WHERE session_hash = $1", _hash(raw))
