"""Tenant-aware config resolution tests for the marketing server."""
import asyncio

from mcp_common.tenant import TenantContext, tenant_scope

from config import config, current_config, _env_config


def _tenant(slug):
    return TenantContext(
        tenant_id=f"id-{slug}", slug=slug, scopes=frozenset({"read"}),
        settings={
            "google_ads_customer_id": f"gads-{slug}",
            "meta_ad_account_id": f"act_{slug}",
            "instagram_business_account_id": f"ig-{slug}",
        },
        credentials={
            "google_ads": {"developer_token": "d", "client_id": "c",
                           "client_secret": "s", "refresh_token": "r"},
            "meta": {"access_token": "t", "app_id": "a", "app_secret": "s"},
        },
    )


def test_env_fallback_outside_tenant_context():
    assert current_config() is _env_config


def test_no_baked_account_id_defaults():
    """Account IDs must come only from env or tenant settings, never source-code defaults."""
    import os
    if not os.getenv("GOOGLE_ADS_CUSTOMER_ID"):
        assert _env_config.google_ads_customer_id == ""
    if not os.getenv("META_AD_ACCOUNT_ID"):
        assert _env_config.meta_ad_account_id == ""


def test_tenant_overrides_env():
    with tenant_scope(_tenant("alpha")):
        assert config.google_ads_customer_id == "gads-alpha"
        assert config.meta_ad_account_id == "act_alpha"
        assert config.google_ads_ready is True
        assert config.meta_ready is True
        assert config.instagram_ready is False  # no instagram credential enrolled
    assert current_config() is _env_config


async def test_concurrent_tenants_no_bleed():
    async def read(slug):
        with tenant_scope(_tenant(slug)):
            await asyncio.sleep(0.01)
            assert config.meta_ad_account_id == f"act_{slug}"
            return config.google_ads_customer_id

    results = await asyncio.gather(read("a"), read("b"), read("c"))
    assert results == ["gads-a", "gads-b", "gads-c"]
