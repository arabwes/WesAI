"""
Shibam Coffee — Financial MCP Server

Connects Claude.ai to live financial data from QuickBooks, Toast (financial extensions),
Gmail invoice parsing, payroll (QuickBooks + WhenIWork), and Google Sheets inventory.

Transport: HTTP/SSE (required for Claude.ai web)
Add to Claude.ai: Settings → Integrations → paste your Railway URL + /sse

Note: This is a SEPARATE server from shibam-marketing-mcp.
      Add both SSE URLs to Claude.ai Integrations for full coverage.
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
)
from tools.email_invoices import (
    parse_vendor_invoices,
    vendor_spend_summary,
    invoice_reconciliation_check,
    invoice_ledger_sync,
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

mcp = FastMCP(config.server_name)

# ── Toast Financial Extensions (13 tools) ────────────────────────────────────
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

# ── Email Invoice Parser (4 tools) ───────────────────────────────────────────
mcp.tool()(parse_vendor_invoices)
mcp.tool()(vendor_spend_summary)
mcp.tool()(invoice_reconciliation_check)
mcp.tool()(invoice_ledger_sync)

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


@mcp.custom_route("/", methods=["GET"])
async def health_check(request):
    """Health check endpoint used by Railway.app."""
    from starlette.responses import JSONResponse
    vendor_count = len(config.vendor_domains)
    return JSONResponse({
        "status": "ok",
        "server": config.server_name,
        "tools": 28,
        "toast_pending": config.toast_api_pending,
        "vendor_domains_configured": vendor_count,
    })


if __name__ == "__main__":
    logger.info("Starting %s on port %d", config.server_name, config.port)
    logger.info("Toast API pending: %s", config.toast_api_pending)
    logger.info("Vendor domains configured: %d", len(config.vendor_domains))
    for name, domain in config.vendor_domains.items():
        logger.info("  Vendor: %s → %s", name, domain)
    mcp.run(transport="sse", host="0.0.0.0", port=config.port)
