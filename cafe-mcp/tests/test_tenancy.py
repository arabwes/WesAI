"""Tenant-aware config resolution tests: the module-level `config` proxy must
serve tenant-scoped values inside a tenant context and env values outside it,
with zero bleed between concurrent tenants."""
import asyncio

from mcp_common.tenant import TenantContext, tenant_scope

from config import config, current_config, _env_config


def _tenant(slug, guid):
    return TenantContext(
        tenant_id=f"id-{slug}", slug=slug, scopes=frozenset({"read"}),
        settings={
            "sheets_inventory_id": f"sheet-{slug}",
            "vendor_domains": {slug: f"{slug}.example.com"},
            "meta_ad_account_id": f"act_{slug}",
        },
        credentials={
            "toast": {"client_id": f"cid-{slug}", "client_secret": "s",
                      "restaurant_guid": guid, "environment": "sandbox"},
            "google": {"client_id": "g", "client_secret": "s", "refresh_token": "r"},
            "meta": {"access_token": "t", "app_id": "a", "app_secret": "s"},
        },
    )


def test_env_fallback_outside_tenant_context():
    assert current_config() is _env_config
    assert config.server_name == _env_config.server_name


def test_tenant_overrides_env():
    with tenant_scope(_tenant("alpha", "guid-alpha")):
        assert config.toast_restaurant_guid == "guid-alpha"
        assert config.toast_client_id == "cid-alpha"
        assert config.sheets_inventory_id == "sheet-alpha"
        assert config.toast_environment == "sandbox"
        assert config.google_ready is True
        assert config.toast_ready is True  # creds present, pending defaults False
        assert config.qb_ready is False    # no quickbooks bundle enrolled
    # context resets cleanly
    assert current_config() is _env_config


async def test_concurrent_tenants_no_bleed():
    async def read_guid(slug, guid):
        with tenant_scope(_tenant(slug, guid)):
            await asyncio.sleep(0.01)
            assert config.toast_restaurant_guid == guid
            await asyncio.sleep(0.01)
            return config.toast_client_id

    results = await asyncio.gather(
        read_guid("a", "guid-a"), read_guid("b", "guid-b"), read_guid("c", "guid-c"),
    )
    assert results == ["cid-a", "cid-b", "cid-c"]


def test_no_baked_account_id_defaults():
    """Account IDs must come only from env or tenant settings, never source-code defaults."""
    import os
    if not os.getenv("GOOGLE_ADS_CUSTOMER_ID"):
        assert _env_config.google_ads_customer_id == ""
    if not os.getenv("META_AD_ACCOUNT_ID"):
        assert _env_config.meta_ad_account_id == ""


def test_marketing_fields_tenant_scoped():
    with tenant_scope(_tenant("alpha", "guid-alpha")):
        assert config.meta_ad_account_id == "act_alpha"
        assert config.meta_ready is True
        assert config.google_ads_ready is False  # no google_ads bundle enrolled
