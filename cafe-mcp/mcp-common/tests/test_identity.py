"""Unit tests for mcp_common.identity (link/find/session lifecycle) against
a fake in-memory pool — mirrors the monkeypatching style used elsewhere
(test_onboarding_portal.py) rather than requiring a real Postgres."""
import time
import uuid

import pytest

from mcp_common import identity


class FakePool:
    """Enough of asyncpg's pool interface for identity.py's queries."""

    def __init__(self):
        self.identities = {}   # (provider, provider_user_id) -> row dict
        self.sessions = {}     # session_hash -> row dict
        self.tenants = {"t1": {"slug": "acme", "name": "Acme Coffee", "status": "active"}}

    async def execute(self, query, *args):
        q = " ".join(query.split())
        if q.startswith("INSERT INTO tenant_identities"):
            tenant_id, provider, provider_user_id, email = args
            key = (provider, provider_user_id)
            existing = self.identities.get(key)
            iid = existing["id"] if existing else str(uuid.uuid4())
            self.identities[key] = {
                "id": iid, "tenant_id": tenant_id, "provider": provider,
                "provider_user_id": provider_user_id, "email": email, "last_login_at": None,
            }
        elif q.startswith("UPDATE tenant_identities SET last_login_at"):
            (iid,) = args
            for row in self.identities.values():
                if row["id"] == iid:
                    row["last_login_at"] = time.time()
        elif q.startswith("INSERT INTO portal_sessions"):
            tenant_id, identity_id, session_hash, ttl_hours, ua, ip = args
            self.sessions[session_hash] = {
                "tenant_id": tenant_id, "identity_id": identity_id,
                "expires_at": time.time() + ttl_hours * 3600,
            }
        elif q.startswith("DELETE FROM portal_sessions"):
            (session_hash,) = args
            self.sessions.pop(session_hash, None)
        return "OK"

    async def fetchrow(self, query, *args):
        q = " ".join(query.split())
        if "FROM tenant_identities i JOIN tenants t" in q:
            provider, provider_user_id = args
            row = self.identities.get((provider, provider_user_id))
            if row is None:
                return None
            tenant = self.tenants[row["tenant_id"]]
            return {
                "identity_id": row["id"], "email": row["email"],
                "tenant_id": row["tenant_id"], "slug": tenant["slug"],
                "name": tenant["name"], "status": tenant["status"],
            }
        if "FROM portal_sessions s" in q:
            (session_hash,) = args
            row = self.sessions.get(session_hash)
            if row is None or row["expires_at"] <= time.time():
                return None
            identity_row = next(r for r in self.identities.values() if r["id"] == row["identity_id"])
            tenant = self.tenants[row["tenant_id"]]
            return {
                "tenant_id": row["tenant_id"], "identity_id": row["identity_id"],
                "email": identity_row["email"], "slug": tenant["slug"],
                "name": tenant["name"], "status": tenant["status"],
            }
        return None


@pytest.fixture
def pool(monkeypatch):
    fake = FakePool()
    async def fake_get_pool():
        return fake
    monkeypatch.setattr(identity, "get_pool", fake_get_pool)
    return fake


async def test_link_and_find(pool):
    await identity.link_identity("t1", "google", "sub-1", "owner@acme.test")
    found = await identity.find_tenant_by_identity("google", "sub-1")
    assert found is not None
    assert found.slug == "acme"
    assert found.email == "owner@acme.test"


async def test_find_unknown_identity_returns_none(pool):
    assert await identity.find_tenant_by_identity("google", "nope") is None
    assert await identity.find_tenant_by_identity("facebook", "nope") is None


async def test_relink_upserts_email(pool):
    await identity.link_identity("t1", "google", "sub-1", "old@acme.test")
    await identity.link_identity("t1", "google", "sub-1", "new@acme.test")
    found = await identity.find_tenant_by_identity("google", "sub-1")
    assert found.email == "new@acme.test"


async def test_google_and_facebook_ids_are_independent(pool):
    await identity.link_identity("t1", "google", "shared-id", "g@acme.test")
    await identity.link_identity("t1", "facebook", "shared-id", "f@acme.test")
    g = await identity.find_tenant_by_identity("google", "shared-id")
    f = await identity.find_tenant_by_identity("facebook", "shared-id")
    assert g.email == "g@acme.test"
    assert f.email == "f@acme.test"


async def test_session_lifecycle(pool):
    await identity.link_identity("t1", "google", "sub-1", "owner@acme.test")
    found = await identity.find_tenant_by_identity("google", "sub-1")

    raw = await identity.create_session("t1", found.identity_id, "pytest-ua", "127.0.0.1")
    assert raw

    session = await identity.verify_session(raw)
    assert session is not None
    assert session.slug == "acme"

    await identity.revoke_session(raw)
    assert await identity.verify_session(raw) is None


async def test_verify_session_rejects_garbage(pool):
    assert await identity.verify_session("") is None
    assert await identity.verify_session("not-a-real-session") is None


async def test_verify_session_expired(pool, monkeypatch):
    await identity.link_identity("t1", "google", "sub-1", "owner@acme.test")
    found = await identity.find_tenant_by_identity("google", "sub-1")
    raw = await identity.create_session("t1", found.identity_id)

    # force expiry
    for row in pool.sessions.values():
        row["expires_at"] = time.time() - 1
    assert await identity.verify_session(raw) is None


async def test_revoke_nonexistent_is_a_noop(pool):
    await identity.revoke_session("never-existed")  # must not raise
    await identity.revoke_session("")
