"""
Tier 1/2 smoke tests for every actively-registered tool in cafe-mcp (unified server).

See TEST_PLAN.md for the full strategy. Short version: these tests run with
no live credentials configured. Tier 1 checks every registered tool imports
and is an async callable. Tier 2 calls every non-mutating tool with safe
default args and asserts it returns gracefully (no traceback) — each tool
guards its own missing-config case internally, so this validates wiring,
not live data correctness.
"""
import inspect

import pytest

from tools.email_invoices import (
    parse_vendor_invoices,
    vendor_spend_summary,
    invoice_reconciliation_check,
    invoice_ledger_sync,
)
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
from tools.toast_sales_analytics import (
    toast_sales_by_daypart,
    toast_hourly_revenue,
)
from tools.weekly_digest import weekly_marketing_digest

START = "2025-05-01"
END = "2025-05-07"

# Read-only tools eligible for Tier 2 invocation, with safe default kwargs.
READ_ONLY_TOOLS = {
    "parse_vendor_invoices": (parse_vendor_invoices, dict(start_date=START, end_date=END)),
    "vendor_spend_summary": (vendor_spend_summary, dict(start_date=START, end_date=END)),
    "invoice_reconciliation_check": (invoice_reconciliation_check, dict(start_date=START, end_date=END)),
    "toast_modifier_revenue": (toast_modifier_revenue, dict(start_date=START, end_date=END)),
    "toast_labor_summary": (toast_labor_summary, dict(start_date=START, end_date=END)),
    "toast_labor_vs_revenue": (toast_labor_vs_revenue, dict()),
    "toast_void_refund_summary": (toast_void_refund_summary, dict(start_date=START, end_date=END)),
    "toast_tips_summary": (toast_tips_summary, dict(start_date=START, end_date=END)),
    "toast_tip_calculator": (toast_tip_calculator, dict(start_date=START, end_date=END)),
    "toast_break_compliance": (toast_break_compliance, dict(start_date=START, end_date=END)),
    "toast_item_sales_detail": (toast_item_sales_detail, dict(start_date=START, end_date=END)),
    "toast_waste_by_category": (toast_waste_by_category, dict(start_date=START, end_date=END)),
    "toast_guest_report": (toast_guest_report, dict(start_date=START, end_date=END)),
    "toast_payout_reconciliation": (toast_payout_reconciliation, dict(start_date=START, end_date=END)),
    "toast_payment_channel_breakdown": (toast_payment_channel_breakdown, dict(start_date=START, end_date=END)),
    "toast_payment_type_breakdown": (toast_payment_type_breakdown, dict(start_date=START, end_date=END)),
    "toast_sales_breakdown": (toast_sales_breakdown, dict(start_date=START, end_date=END)),
    "payroll_summary": (payroll_summary, dict(start_date=START, end_date=END)),
    "payroll_by_role": (payroll_by_role, dict(start_date=START, end_date=END)),
    "payroll_labor_percentage": (payroll_labor_percentage, dict(start_date=START, end_date=END)),
    "payroll_schedule_overview": (payroll_schedule_overview, dict()),
    "whenIwork_schedule": (whenIwork_schedule, dict(start_date=START, end_date=END)),
    "whenIwork_labor_forecast": (whenIwork_labor_forecast, dict()),
    "whenIwork_schedule_cost": (whenIwork_schedule_cost, dict()),
    "whenIwork_punctuality_check": (whenIwork_punctuality_check, dict(start_date=START, end_date=END)),
    "inventory_current": (inventory_current, dict()),
    "inventory_valuation": (inventory_valuation, dict()),
    "inventory_low_stock": (inventory_low_stock, dict()),
    "inventory_vs_sales": (inventory_vs_sales, dict(start_date=START, end_date=END)),
    "inventory_reorder_list": (inventory_reorder_list, dict()),
    "weekly_financial_digest": (weekly_financial_digest, dict()),
    "monthly_financial_close_checklist": (monthly_financial_close_checklist, dict()),
    "toast_sales_by_hour": (toast_sales_by_hour, dict(start_date=START, end_date=END)),
    "toast_labor_hourly_headcount": (toast_labor_hourly_headcount, dict(start_date=START, end_date=END)),
    "toast_labor_detail_by_day": (toast_labor_detail_by_day, dict(start_date=START, end_date=END)),
    "toast_labor_cost_by_hour": (toast_labor_cost_by_hour, dict(start_date=START, end_date=END)),
    "toast_get_employees": (toast_get_employees, dict()),

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

# Mutating tools: writes to live systems. Tier 1 (import/signature) only.
MUTATING_TOOLS = {
    "invoice_ledger_sync": invoice_ledger_sync,
    "toast_create_employee": toast_create_employee,
    "toast_update_employee": toast_update_employee,
    "toast_unarchive_employee": toast_unarchive_employee,
    "sheets_write_labor_report": sheets_write_labor_report,
}

ALL_TOOLS = {**{k: v[0] for k, v in READ_ONLY_TOOLS.items()}, **MUTATING_TOOLS}


@pytest.mark.parametrize("name", sorted(ALL_TOOLS))
def test_tool_is_async_callable(name):
    fn = ALL_TOOLS[name]
    assert inspect.iscoroutinefunction(fn), f"{name} must be an async function"


@pytest.mark.parametrize("name", sorted(MUTATING_TOOLS))
def test_mutating_tool_skipped(name):
    pytest.skip(f"{name} mutates live data — verify manually against staging, not in automated smoke tests")


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(READ_ONLY_TOOLS))
async def test_read_only_tool_smoke(name):
    fn, kwargs = READ_ONLY_TOOLS[name]
    result = await fn(**kwargs)
    assert result is not None
    assert isinstance(result, (str, dict, list)), f"{name} returned unexpected type {type(result)}"
    if isinstance(result, str):
        assert result.strip(), f"{name} returned an empty string"
