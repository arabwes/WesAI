"""Tenant/key/credential/settings CRUD over asyncpg, with a TTL cache for
per-request tenant loading. All credential payloads are encrypted with
CredentialCipher before touching the database."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Any

from mcp_common.crypto import CredentialCipher
from mcp_common.db import get_pool
from mcp_common.tenant import TenantContext

_TENANT_CACHE_TTL_S = 60.0
_tenant_cache: dict[str, tuple[float, TenantContext]] = {}

KEY_PREFIX = "wes_"


def hash_key(raw_key: str) -> bytes:
    return hashlib.sha256(raw_key.encode()).digest()


def mint_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(32)


async def _load_settings_and_credentials(conn, tenant_id, cipher: CredentialCipher) -> tuple[dict, dict]:
    settings_row = await conn.fetchrow(
        "SELECT settings FROM tenant_settings WHERE tenant_id = $1", tenant_id
    )
    cred_rows = await conn.fetch(
        "SELECT service, key_id, ciphertext FROM tenant_credentials WHERE tenant_id = $1",
        tenant_id,
    )
    credentials = {
        r["service"]: json.loads(cipher.decrypt(r["key_id"], bytes(r["ciphertext"])))
        for r in cred_rows
    }
    settings = json.loads(settings_row["settings"]) if settings_row else {}
    return settings, credentials


async def resolve_api_key(raw_key: str, cipher: CredentialCipher) -> TenantContext | None:
    """Look up an API key by hash; return the fully-loaded tenant context or None.

    Lookup is by unique hash index, so timing does not depend on which byte
    of an attacker's key differs.
    """
    digest = hash_key(raw_key)
    cache_key = digest.hex()
    hit = _tenant_cache.get(cache_key)
    if hit and (time.monotonic() - hit[0]) < _TENANT_CACHE_TTL_S:
        return hit[1]

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT k.id AS key_id, k.scopes, t.id AS tenant_id, t.slug, t.status
            FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
            WHERE k.key_hash = $1 AND k.revoked_at IS NULL
            """,
            digest,
        )
        if row is None or row["status"] != "active":
            return None
        settings, credentials = await _load_settings_and_credentials(conn, row["tenant_id"], cipher)
        await conn.execute(
            "UPDATE api_keys SET last_used_at = now() WHERE id = $1", row["key_id"]
        )

    ctx = TenantContext(
        tenant_id=str(row["tenant_id"]),
        slug=row["slug"],
        scopes=frozenset(row["scopes"]),
        settings=settings,
        credentials=credentials,
        api_key_id=str(row["key_id"]),
    )
    _tenant_cache[cache_key] = (time.monotonic(), ctx)
    return ctx


async def load_tenant_by_slug(slug: str, scopes: frozenset, cipher: CredentialCipher) -> TenantContext | None:
    """Load a tenant's settings/credentials by slug (not by API key) — used to
    resolve OAuth-issued access tokens, whose subject is a tenant slug rather
    than a key hash. `scopes` come from the OAuth token itself (already
    filtered against the tenant's key scopes at issuance time)."""
    cache_key = f"slug:{slug}"
    hit = _tenant_cache.get(cache_key)
    if hit and (time.monotonic() - hit[0]) < _TENANT_CACHE_TTL_S:
        cached = hit[1]
        return TenantContext(
            tenant_id=cached.tenant_id, slug=cached.slug, scopes=scopes,
            settings=cached.settings, credentials=cached.credentials,
        )

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, status FROM tenants WHERE slug = $1", slug
        )
        if row is None or row["status"] != "active":
            return None
        settings, credentials = await _load_settings_and_credentials(conn, row["id"], cipher)

    ctx = TenantContext(
        tenant_id=str(row["id"]), slug=slug, scopes=scopes,
        settings=settings, credentials=credentials,
    )
    _tenant_cache[cache_key] = (time.monotonic(), ctx)
    return ctx


def invalidate_tenant_cache() -> None:
    _tenant_cache.clear()


# ── Admin operations (used by scripts/tenant_admin.py) ────────────────────────

async def create_tenant(slug: str, name: str) -> str:
    pool = await get_pool()
    row = await pool.fetchrow(
        "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id", slug, name
    )
    await pool.execute(
        "INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", row["id"]
    )
    return str(row["id"])


async def create_api_key(tenant_slug: str, scopes: list[str], label: str = "") -> str:
    """Returns the raw key ONCE; only its hash is stored."""
    raw = mint_key()
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO api_keys (tenant_id, key_hash, scopes, label)
        SELECT id, $2, $3, $4 FROM tenants WHERE slug = $1
        """,
        tenant_slug, hash_key(raw), scopes, label,
    )
    invalidate_tenant_cache()
    return raw

async def revoke_api_key(raw_or_prefix: str) -> int:
    pool = await get_pool()
    result = await pool.execute(
        "UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1 AND revoked_at IS NULL",
        hash_key(raw_or_prefix),
    )
    invalidate_tenant_cache()
    return int(result.split()[-1])


async def set_credential(tenant_slug: str, service: str, secret_bundle: dict[str, Any],
                         cipher: CredentialCipher) -> None:
    key_id, ciphertext = cipher.encrypt(json.dumps(secret_bundle).encode())
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO tenant_credentials (tenant_id, service, key_id, ciphertext)
        SELECT id, $2, $3, $4 FROM tenants WHERE slug = $1
        ON CONFLICT (tenant_id, service)
        DO UPDATE SET key_id = EXCLUDED.key_id, ciphertext = EXCLUDED.ciphertext, updated_at = now()
        """,
        tenant_slug, service, key_id, ciphertext,
    )
    invalidate_tenant_cache()


async def set_settings(tenant_slug: str, patch: dict[str, Any]) -> None:
    pool = await get_pool()
    await pool.execute(
        """
        UPDATE tenant_settings ts SET settings = ts.settings || $2::jsonb, updated_at = now()
        FROM tenants t WHERE t.id = ts.tenant_id AND t.slug = $1
        """,
        tenant_slug, json.dumps(patch),
    )
    invalidate_tenant_cache()


async def reencrypt_all(cipher: CredentialCipher) -> int:
    """Master-key rotation: re-encrypt every credential with the primary key."""
    pool = await get_pool()
    rows = await pool.fetch("SELECT tenant_id, service, key_id, ciphertext FROM tenant_credentials")
    n = 0
    for r in rows:
        if r["key_id"] == cipher.primary_key_id:
            continue
        plaintext = cipher.decrypt(r["key_id"], bytes(r["ciphertext"]))
        key_id, ciphertext = cipher.encrypt(plaintext)
        await pool.execute(
            "UPDATE tenant_credentials SET key_id=$3, ciphertext=$4, updated_at=now() "
            "WHERE tenant_id=$1 AND service=$2",
            r["tenant_id"], r["service"], key_id, ciphertext,
        )
        n += 1
    invalidate_tenant_cache()
    return n


async def credential_services(tenant_slug: str) -> set[str]:
    """Which services have stored credentials (no decryption) — used by the
    onboarding portal to show connected/not-connected status."""
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT c.service FROM tenant_credentials c
        JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = $1
        """,
        tenant_slug,
    )
    return {r["service"] for r in rows}


async def get_settings(tenant_slug: str) -> dict:
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT ts.settings FROM tenant_settings ts
        JOIN tenants t ON t.id = ts.tenant_id WHERE t.slug = $1
        """,
        tenant_slug,
    )
    return json.loads(row["settings"]) if row else {}
