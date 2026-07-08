"""
CLI tool tester — runs any MCP tool directly from the command line.

Usage:
    python scripts/test_tool.py --tool qb_pl_summary
    python scripts/test_tool.py --tool parse_vendor_invoices --params '{"start_date":"2025-05-01","end_date":"2025-05-31"}'
    python scripts/test_tool.py --tool inventory_current --params '{"category":"Beans"}'
    python scripts/test_tool.py --tool weekly_financial_digest
"""
import asyncio
import argparse
import json
import sys

parser = argparse.ArgumentParser(description="Test a shibam-financial-mcp tool")
parser.add_argument("--tool", required=True, help="Tool function name")
parser.add_argument("--params", default="{}", help="JSON string of parameters")
args = parser.parse_args()

params = json.loads(args.params)

# Import all tools
tool_map = {}
try:
    from tools.quickbooks import (
        qb_transaction_detail, qb_receipt_attachments, qb_pl_summary,
        qb_vendor_spend, qb_unreconciled_check, qb_cashflow_summary,
    )
    tool_map.update({
        "qb_transaction_detail": qb_transaction_detail,
        "qb_receipt_attachments": qb_receipt_attachments,
        "qb_pl_summary": qb_pl_summary,
        "qb_vendor_spend": qb_vendor_spend,
        "qb_unreconciled_check": qb_unreconciled_check,
        "qb_cashflow_summary": qb_cashflow_summary,
    })
except Exception as e:
    print(f"Warning: QuickBooks tools failed to import: {e}")

try:
    from tools.toast_financial import (
        toast_modifier_revenue, toast_labor_summary, toast_labor_vs_revenue,
        toast_void_refund_summary, toast_tips_summary,
    )
    tool_map.update({
        "toast_modifier_revenue": toast_modifier_revenue,
        "toast_labor_summary": toast_labor_summary,
        "toast_labor_vs_revenue": toast_labor_vs_revenue,
        "toast_void_refund_summary": toast_void_refund_summary,
        "toast_tips_summary": toast_tips_summary,
    })
except Exception as e:
    print(f"Warning: Toast financial tools failed to import: {e}")

try:
    from tools.email_invoices import (
        parse_vendor_invoices, vendor_spend_summary,
        invoice_reconciliation_check, invoice_ledger_sync,
    )
    tool_map.update({
        "parse_vendor_invoices": parse_vendor_invoices,
        "vendor_spend_summary": vendor_spend_summary,
        "invoice_reconciliation_check": invoice_reconciliation_check,
        "invoice_ledger_sync": invoice_ledger_sync,
    })
except Exception as e:
    print(f"Warning: Email invoice tools failed to import: {e}")

try:
    from tools.payroll import (
        payroll_summary, payroll_by_role, payroll_labor_percentage, payroll_schedule_overview,
    )
    tool_map.update({
        "payroll_summary": payroll_summary,
        "payroll_by_role": payroll_by_role,
        "payroll_labor_percentage": payroll_labor_percentage,
        "payroll_schedule_overview": payroll_schedule_overview,
    })
except Exception as e:
    print(f"Warning: Payroll tools failed to import: {e}")

try:
    from tools.wheniwork import whenIwork_schedule, whenIwork_labor_forecast, whenIwork_schedule_cost
    tool_map.update({
        "whenIwork_schedule": whenIwork_schedule,
        "whenIwork_labor_forecast": whenIwork_labor_forecast,
        "whenIwork_schedule_cost": whenIwork_schedule_cost,
    })
except Exception as e:
    print(f"Warning: WhenIWork tools failed to import: {e}")

try:
    from tools.inventory import (
        inventory_current, inventory_valuation, inventory_low_stock,
        inventory_vs_sales, inventory_reorder_list,
    )
    tool_map.update({
        "inventory_current": inventory_current,
        "inventory_valuation": inventory_valuation,
        "inventory_low_stock": inventory_low_stock,
        "inventory_vs_sales": inventory_vs_sales,
        "inventory_reorder_list": inventory_reorder_list,
    })
except Exception as e:
    print(f"Warning: Inventory tools failed to import: {e}")

try:
    from tools.financial_digest import weekly_financial_digest, monthly_financial_close_checklist
    tool_map.update({
        "weekly_financial_digest": weekly_financial_digest,
        "monthly_financial_close_checklist": monthly_financial_close_checklist,
    })
except Exception as e:
    print(f"Warning: Digest tools failed to import: {e}")

if args.tool not in tool_map:
    print(f"Unknown tool: {args.tool}")
    print(f"Available tools: {', '.join(sorted(tool_map.keys()))}")
    sys.exit(1)

fn = tool_map[args.tool]
print(f"Running {args.tool}({params})\n{'='*50}")
result = asyncio.run(fn(**params))
print(result)
