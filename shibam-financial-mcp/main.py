"""
Shibam Coffee — Financial MCP Server

Connects Claude.ai to live financial data from QuickBooks, Toast (financial extensions),
Gmail invoice parsing, payroll (QuickBooks + WhenIWork), and Google Sheets inventory.

Transport: Streamable HTTP (required for Claude.ai remote integrations)
Add to Claude.ai: Settings → Integrations → paste your Railway URL + /mcp

Note: This is a SEPARATE server from shibam-marketing-mcp.
      Add both /mcp URLs to Claude.ai Integrations for full coverage.
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

mcp = FastMCP(config.server_name)

# ── QuickBooks (6 tools) — disabled, see import comment above ───────────────
# mcp.tool()(qb_transaction_detail)
# mcp.tool()(qb_receipt_attachments)
# mcp.tool()(qb_pl_summary)
# mcp.tool()(qb_vendor_spend)
# mcp.tool()(qb_unreconciled_check)
# mcp.tool()(qb_cashflow_summary)

# ── Toast Financial Extensions (14 tools) ────────────────────────────────────
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

# ── Email Invoice Parser (4 tools) ───────────────────────────────────────────
mcp.tool()(parse_vendor_invoices)
mcp.tool()(vendor_spend_summary)
mcp.tool()(invoice_reconciliation_check)
mcp.tool()(invoice_ledger_sync)

# ── Payroll (4 tools) ────────────────────────────────────────────────────────
mcp.tool()(payroll_summary)
mcp.tool()(payroll_by_role)
mcp.tool()(payroll_labor_percentage)
mcp.tool()(payroll_schedule_overview)

# ── WhenIWork (4 tools) ──────────────────────────────────────────────────────
mcp.tool()(whenIwork_schedule)
mcp.tool()(whenIwork_labor_forecast)
mcp.tool()(whenIwork_schedule_cost)
mcp.tool()(whenIwork_punctuality_check)

# ── Inventory (5 tools) ──────────────────────────────────────────────────────
mcp.tool()(inventory_current)
mcp.tool()(inventory_valuation)
mcp.tool()(inventory_low_stock)
mcp.tool()(inventory_vs_sales)
mcp.tool()(inventory_reorder_list)

# ── Financial Digest (2 composite tools) ─────────────────────────────────────
mcp.tool()(weekly_financial_digest)
mcp.tool()(monthly_financial_close_checklist)

# ── Toast Labor Analytics (4 tools) ──────────────────────────────────────────
mcp.tool()(toast_sales_by_hour)
mcp.tool()(toast_labor_hourly_headcount)
mcp.tool()(toast_labor_detail_by_day)
mcp.tool()(toast_labor_cost_by_hour)

# ── Toast Employee Management (4 tools — stubbed pending API approval) ──────
mcp.tool()(toast_get_employees)
mcp.tool()(toast_create_employee)
mcp.tool()(toast_update_employee)
mcp.tool()(toast_unarchive_employee)

# ── Google Sheets Write-Back (1 tool) ────────────────────────────────────────
mcp.tool()(sheets_write_labor_report)


@mcp.custom_route("/", methods=["GET"])
async def health_check(request):
    """Health check endpoint used by Railway.app."""
    from starlette.responses import JSONResponse
    vendor_count = len(config.vendor_domains)
    return JSONResponse({
        "status": "ok",
        "server": config.server_name,
        "tools": 48,
        "toast_pending": config.toast_api_pending,
        "vendor_domains_configured": vendor_count,
    })


if __name__ == "__main__":
    logger.info("Starting %s on port %d", config.server_name, config.port)
    logger.info("Toast API pending: %s", config.toast_api_pending)
    logger.info("Vendor domains configured: %d", len(config.vendor_domains))
    for name, domain in config.vendor_domains.items():
        logger.info("  Vendor: %s → %s", name, domain)
    mcp.run(transport="http", host="0.0.0.0", port=config.port)
