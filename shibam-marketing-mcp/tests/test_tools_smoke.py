"""
Tier 1/2 smoke tests for every actively-registered tool in shibam-marketing-mcp.

See TEST_PLAN.md for the full strategy. All tools here are read-only, so
every one gets both an import/callable check and a live invocation with
safe default args, asserting no exception and a graceful return.
"""
import inspect

import pytest

from tools.google_ads import (
    google_ads_campaign_performance,
    google_ads_spend_summary,
    google_ads_kpi_check,
    google_ads_asset_review,
    google_ads_impression_share,
)
from tools.meta_ads import (
    meta_ads_campaign_performance,
    meta_ads_kpi_check,
    meta_ads_objective_breakdown,
    meta_ads_creative_performance,
)
from tools.toast_pos import (
    toast_sales_summary,
    toast_top_items,
    toast_weekend_evening_share,
    toast_hourly_heatmap,
    toast_category_breakdown,
)
from tools.google_business import (
    gbp_review_summary,
    gbp_profile_completeness,
    gbp_competitor_listings,
)
from tools.instagram import (
    instagram_account_summary,
    instagram_post_performance,
    instagram_engagement_rate,
)
from tools.toast_sales_analytics import (
    toast_sales_by_daypart,
    toast_hourly_revenue,
)
from tools.weekly_digest import weekly_marketing_digest

START = "2025-05-01"
END = "2025-05-07"

ALL_TOOLS = {
    "google_ads_campaign_performance": (google_ads_campaign_performance, dict()),
    "google_ads_spend_summary": (google_ads_spend_summary, dict()),
    "google_ads_kpi_check": (google_ads_kpi_check, dict()),
    "google_ads_asset_review": (google_ads_asset_review, dict()),
    "google_ads_impression_share": (google_ads_impression_share, dict()),
    "meta_ads_campaign_performance": (meta_ads_campaign_performance, dict()),
    "meta_ads_kpi_check": (meta_ads_kpi_check, dict()),
    "meta_ads_objective_breakdown": (meta_ads_objective_breakdown, dict()),
    "meta_ads_creative_performance": (meta_ads_creative_performance, dict()),
    "toast_sales_summary": (toast_sales_summary, dict(start_date=START, end_date=END)),
    "toast_top_items": (toast_top_items, dict()),
    "toast_weekend_evening_share": (toast_weekend_evening_share, dict()),
    "toast_hourly_heatmap": (toast_hourly_heatmap, dict()),
    "toast_category_breakdown": (toast_category_breakdown, dict()),
    "gbp_review_summary": (gbp_review_summary, dict()),
    "gbp_profile_completeness": (gbp_profile_completeness, dict()),
    "gbp_competitor_listings": (gbp_competitor_listings, dict()),
    "instagram_account_summary": (instagram_account_summary, dict()),
    "instagram_post_performance": (instagram_post_performance, dict()),
    "instagram_engagement_rate": (instagram_engagement_rate, dict()),
    "toast_sales_by_daypart": (toast_sales_by_daypart, dict(start_date=START, end_date=END)),
    "toast_hourly_revenue": (toast_hourly_revenue, dict(start_date=START, end_date=END)),
    "weekly_marketing_digest": (weekly_marketing_digest, dict()),
}


@pytest.mark.parametrize("name", sorted(ALL_TOOLS))
def test_tool_is_async_callable(name):
    fn, _ = ALL_TOOLS[name]
    assert inspect.iscoroutinefunction(fn), f"{name} must be an async function"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(ALL_TOOLS))
async def test_tool_smoke(name):
    fn, kwargs = ALL_TOOLS[name]
    result = await fn(**kwargs)
    assert result is not None
    assert isinstance(result, (str, dict, list)), f"{name} returned unexpected type {type(result)}"
    if isinstance(result, str):
        assert result.strip(), f"{name} returned an empty string"
