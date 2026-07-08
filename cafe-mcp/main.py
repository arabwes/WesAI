"""
Cafe MCP — unified small-business MCP server.

One server covering financial operations (QuickBooks, Gmail invoices,
payroll, WhenIWork, inventory, Toast labor/financial) and marketing
analytics (Google Ads, Meta Ads, Instagram, Google Business Profile,
Toast sales/revenue).

Transport: Streamable HTTP behind bearer-token auth (see mcp_common).
Add to Claude.ai / ChatGPT: paste the deployment URL + /mcp with an
Authorization: Bearer header.
"""
import logging
from fastmcp import FastMCP
from config import config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

# ── Import all tools ──────────────────────────────────────────────────────────
# QuickBooks tools disabled — their availability was confusing the AI using them.
# from tools.quickbooks import (
#     qb_transaction_detail,
#     qb_receipt_attachments,
#     qb_pl_summary,
#     qb_vendor_spend,
#     qb_unreconciled_check,
#     qb_cashflow_summary,
# )
from tools.toast_financial import (
    toast_modifier_revenue,
    toast_labor_summary,
    toast_labor_vs_revenue,
    toast_void_refund_summary,
    toast_tips_summary,
    toast_tip_calculator,
    toast_break_compliance,
    toast_item_sales_detail,
    toast_waste_by_category,
    toast_guest_report,
    toast_payout_reconciliation,
    toast_payment_channel_breakdown,
    toast_payment_type_breakdown,
    toast_sales_breakdown,
)
from tools.email_invoices import (
    parse_vendor_invoices,
    vendor_spend_summary,
    invoice_reconciliation_check,
    invoice_ledger_sync,
)
from tools.payroll import (
    payroll_summary,
    payroll_by_role,
    payroll_labor_percentage,
    payroll_schedule_overview,
)
from tools.wheniwork import (
    whenIwork_schedule,
    whenIwork_labor_forecast,
    whenIwork_schedule_cost,
    whenIwork_punctuality_check,
)
from tools.inventory import (
    inventory_current,
    inventory_valuation,
    inventory_low_stock,
    inventory_vs_sales,
    inventory_reorder_list,
)
from tools.financial_digest import (
    weekly_financial_digest,
    monthly_financial_close_checklist,
)
from tools.toast_labor_analytics import (
    toast_sales_by_hour,
    toast_labor_hourly_headcount,
    toast_labor_detail_by_day,
    toast_labor_cost_by_hour,
)
from tools.toast_employees import (
    toast_get_employees,
    toast_create_employee,
    toast_update_employee,
    toast_unarchive_employee,
)
from tools.sheets_writeback import sheets_write_labor_report
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

# ── QuickBooks (6 tools) — disabled, see import comment above ────────────────
# mcp.tool()(qb_transaction_detail)
# mcp.tool()(qb_receipt_attachments)
# mcp.tool()(qb_pl_summary)
# mcp.tool()(qb_vendor_spend)
# mcp.tool()(qb_unreconciled_check)
# mcp.tool()(qb_cashflow_summary)

# ── Toast Financial (14 tools) ────────────────────────────────────────────────
mcp.tool()(toast_modifier_revenue)
mcp.tool()(toast_labor_summary)
mcp.tool()(toast_labor_vs_revenue)
mcp.tool()(toast_void_refund_summary)
mcp.tool()(toast_tips_summary)
mcp.tool()(toast_tip_calculator)
mcp.tool()(toast_break_compliance)
mcp.tool()(toast_item_sales_detail)
mcp.tool()(toast_waste_by_category)
mcp.tool()(toast_guest_report)
mcp.tool()(toast_payout_reconciliation)
mcp.tool()(toast_payment_channel_breakdown)
mcp.tool()(toast_payment_type_breakdown)
mcp.tool()(toast_sales_breakdown)

# ── Email Invoices (4 tools) ──────────────────────────────────────────────────
mcp.tool()(parse_vendor_invoices)
mcp.tool()(vendor_spend_summary)
mcp.tool()(invoice_reconciliation_check)
mcp.tool()(invoice_ledger_sync)

# ── Payroll (4 tools) ─────────────────────────────────────────────────────────
mcp.tool()(payroll_summary)
mcp.tool()(payroll_by_role)
mcp.tool()(payroll_labor_percentage)
mcp.tool()(payroll_schedule_overview)

# ── WhenIWork (4 tools) ───────────────────────────────────────────────────────
mcp.tool()(whenIwork_schedule)
mcp.tool()(whenIwork_labor_forecast)
mcp.tool()(whenIwork_schedule_cost)
mcp.tool()(whenIwork_punctuality_check)

# ── Inventory (5 tools) ───────────────────────────────────────────────────────
mcp.tool()(inventory_current)
mcp.tool()(inventory_valuation)
mcp.tool()(inventory_low_stock)
mcp.tool()(inventory_vs_sales)
mcp.tool()(inventory_reorder_list)

# ── Financial Digest (2 tools) ────────────────────────────────────────────────
mcp.tool()(weekly_financial_digest)
mcp.tool()(monthly_financial_close_checklist)

# ── Toast Labor Analytics (4 tools) ───────────────────────────────────────────
mcp.tool()(toast_sales_by_hour)
mcp.tool()(toast_labor_hourly_headcount)
mcp.tool()(toast_labor_detail_by_day)
mcp.tool()(toast_labor_cost_by_hour)

# ── Toast Employees (4 tools; create/update/unarchive require 'mutate') ──────
mcp.tool()(toast_get_employees)
mcp.tool()(toast_create_employee)
mcp.tool()(toast_update_employee)
mcp.tool()(toast_unarchive_employee)

# ── Google Sheets Write-Back (1 tool; requires 'mutate') ─────────────────────
mcp.tool()(sheets_write_labor_report)

# ── Google Ads (5 tools) ──────────────────────────────────────────────────────
mcp.tool()(google_ads_campaign_performance)
mcp.tool()(google_ads_spend_summary)
mcp.tool()(google_ads_kpi_check)
mcp.tool()(google_ads_asset_review)
mcp.tool()(google_ads_impression_share)

# ── Meta Ads (4 tools) ────────────────────────────────────────────────────────
mcp.tool()(meta_ads_campaign_performance)
mcp.tool()(meta_ads_kpi_check)
mcp.tool()(meta_ads_objective_breakdown)
mcp.tool()(meta_ads_creative_performance)

# ── Toast POS Sales (5 tools) ─────────────────────────────────────────────────
mcp.tool()(toast_sales_summary)
mcp.tool()(toast_top_items)
mcp.tool()(toast_weekend_evening_share)
mcp.tool()(toast_hourly_heatmap)
mcp.tool()(toast_category_breakdown)

# ── Google Business Profile (3 tools) ─────────────────────────────────────────
mcp.tool()(gbp_review_summary)
mcp.tool()(gbp_profile_completeness)
mcp.tool()(gbp_competitor_listings)

# ── Instagram (3 tools) ───────────────────────────────────────────────────────
mcp.tool()(instagram_account_summary)
mcp.tool()(instagram_post_performance)
mcp.tool()(instagram_engagement_rate)

# ── Toast Sales Analytics (2 tools) ───────────────────────────────────────────
mcp.tool()(toast_sales_by_daypart)
mcp.tool()(toast_hourly_revenue)

# ── Marketing Digest (1 composite tool) ───────────────────────────────────────
mcp.tool()(weekly_marketing_digest)


# Public pages ("/" homepage, /health, /privacy, /terms, /data-deletion)
# are registered by mcp_common.serverapp.build_app -> publicsite.py.

if __name__ == "__main__":
    from mcp_common.serverapp import run_server
    run_server(mcp, server_name="cafe-mcp", port=config.port)
