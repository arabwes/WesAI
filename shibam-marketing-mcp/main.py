"""
Shibam Coffee — Marketing MCP Server

Connects Claude.ai to live marketing data from Google Ads, Meta Ads,
Toast POS, Google Business Profile, and Instagram.

Transport: Streamable HTTP (required for Claude.ai remote integrations)
Add to Claude.ai: Settings → Integrations → paste your Railway URL + /mcp
"""
import os
import logging
from fastmcp import FastMCP
from config import config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

# Import all tools
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
from tools.toast_sales_analytics import toast_sales_by_daypart, toast_hourly_revenue
from tools.weekly_digest import weekly_marketing_digest

mcp = FastMCP(config.server_name)

# ── Google Ads (5 tools) ─────────────────────────────────────────────────────
mcp.tool()(google_ads_campaign_performance)
mcp.tool()(google_ads_spend_summary)
mcp.tool()(google_ads_kpi_check)
mcp.tool()(google_ads_asset_review)
mcp.tool()(google_ads_impression_share)

# ── Meta Ads (4 tools) ───────────────────────────────────────────────────────
mcp.tool()(meta_ads_campaign_performance)
mcp.tool()(meta_ads_kpi_check)
mcp.tool()(meta_ads_objective_breakdown)
mcp.tool()(meta_ads_creative_performance)

# ── Toast POS (5 tools) ──────────────────────────────────────────────────────
mcp.tool()(toast_sales_summary)
mcp.tool()(toast_top_items)
mcp.tool()(toast_weekend_evening_share)
mcp.tool()(toast_hourly_heatmap)
mcp.tool()(toast_category_breakdown)

# ── Google Business Profile (3 tools) ────────────────────────────────────────
mcp.tool()(gbp_review_summary)
mcp.tool()(gbp_profile_completeness)
mcp.tool()(gbp_competitor_listings)

# ── Instagram (3 tools) ──────────────────────────────────────────────────────
mcp.tool()(instagram_account_summary)
mcp.tool()(instagram_post_performance)
mcp.tool()(instagram_engagement_rate)

# ── Toast Sales Analytics (2 tools) ──────────────────────────────────────────
mcp.tool()(toast_sales_by_daypart)
mcp.tool()(toast_hourly_revenue)

# ── Weekly Digest (1 composite tool) ─────────────────────────────────────────
mcp.tool()(weekly_marketing_digest)


@mcp.custom_route("/", methods=["GET"])
async def health_check(request):
    """Health check endpoint used by Railway.app."""
    from starlette.responses import JSONResponse
    return JSONResponse({
        "status": "ok",
        "server": config.server_name,
        "tools": 23,
        "toast_pending": config.toast_api_pending,
    })


if __name__ == "__main__":
    logger.info("Starting %s on port %d", config.server_name, config.port)
    logger.info("Toast API pending: %s", config.toast_api_pending)
    if config.toast_api_pending:
        logger.info("Toast tools will return a setup message until TOAST_API_PENDING=false")
    mcp.run(transport="http", host="0.0.0.0", port=config.port)
