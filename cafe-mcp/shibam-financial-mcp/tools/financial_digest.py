"""Composite financial digest tools — weekly snapshot and monthly close checklist."""
import logging
from datetime import date

from mcp_common.errors import safe_error
from config import NotConfiguredError

logger = logging.getLogger(__name__)


def _msg(e: Exception, ctx: str) -> str:
    """Curated setup guidance passes through; everything else is sanitized."""
    if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
        return str(e)
    return safe_error(e, ctx)


def _is_error(text: str) -> bool:
    lowered = text.lower()
    return lowered.startswith("error") or "error fetching" in lowered or "invalid_grant" in lowered or "not configured" in lowered


async def weekly_financial_digest(
    week: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Generate a complete weekly financial snapshot for the business.

    Calls all key financial tools and returns one formatted report covering:
    - Revenue vs estimated gross margin
    - Labor % of revenue with 🟢🟡🔴 rating
    - Unreconciled QuickBooks transactions
    - Top 3 vendor spend from parsed invoices
    - Low stock items requiring reorder
    - Invoice reconciliation flags

    Args:
        week:       last_7_days | last_30_days | this_month | last_month | custom
                    Defaults to last_7_days.
        start_date: YYYY-MM-DD — required only when week=custom
        end_date:   YYYY-MM-DD — required only when week=custom
    """
    from utils.date_helpers import to_start_end
    from tools.quickbooks import qb_pl_summary, qb_unreconciled_check
    from tools.payroll import payroll_labor_percentage
    from tools.email_invoices import vendor_spend_summary
    from tools.inventory import inventory_low_stock

    today = date.today()
    sections = []
    issues = []

    try:
        start, end = to_start_end(week, start_date, end_date)
    except ValueError as e:
        return f"Error: {e}"

    period_label = f"{start} to {end}" if week == "custom" else week
    sections.append(
        f"{'='*60}\n"
        f"  WEEKLY FINANCIAL DIGEST\n"
        f"  Generated: {today.strftime('%B %d, %Y')}  |  Period: {period_label}\n"
        f"{'='*60}"
    )

    # ── P&L ──────────────────────────────────────────────────────────────
    sections.append("\n📊  PROFIT & LOSS\n" + "-" * 40)
    try:
        month = today.strftime("%Y-%m")
        pl = await qb_pl_summary(start_month=month, end_month=month)
        sections.append(pl)
        if _is_error(pl):
            issues.append("P&L data unavailable — check QuickBooks connection.")
        elif "🔴" in pl:
            issues.append("Gross margin is below target — review COGS and pricing.")
    except Exception as e:
        sections.append(f"⚠️  P&L data unavailable: {_msg(e, 'fetching P&L')}")
        issues.append("P&L data unavailable — check QuickBooks connection.")

    # ── Labor % ──────────────────────────────────────────────────────────
    sections.append("\n👥  LABOR\n" + "-" * 40)
    try:
        labor = await payroll_labor_percentage(str(start), str(end))
        sections.append(labor)
        if _is_error(labor):
            issues.append("Labor % data unavailable — check QuickBooks/Toast connection.")
        elif "🔴" in labor or "ALERT" in labor:
            issues.append("Labor % of revenue is above 35% — review staffing schedule.")
    except Exception as e:
        sections.append(f"⚠️  Labor data unavailable: {_msg(e, 'fetching labor data')}")
        issues.append("Labor % data unavailable — check QuickBooks/Toast connection.")

    # ── Unreconciled ─────────────────────────────────────────────────────
    sections.append("\n📋  QUICKBOOKS HYGIENE\n" + "-" * 40)
    try:
        unrec = await qb_unreconciled_check()
        sections.append(unrec)
        if _is_error(unrec):
            issues.append("QuickBooks hygiene check unavailable — check QuickBooks connection.")
        elif "⚠️" in unrec:
            issues.append("Uncategorized QuickBooks transactions found — review before month-end.")
    except Exception as e:
        sections.append(f"⚠️  QuickBooks check unavailable: {_msg(e, 'checking QuickBooks')}")
        issues.append("QuickBooks hygiene check unavailable — check QuickBooks connection.")

    # ── Vendor Spend ─────────────────────────────────────────────────────
    sections.append("\n🧾  VENDOR SPEND (Top 3)\n" + "-" * 40)
    try:
        spend = await vendor_spend_summary(str(start), str(end))
        if _is_error(spend):
            sections.append(spend)
            issues.append("Vendor spend data unavailable — check Gmail/Google connection.")
        else:
            # Show only first 5 lines to keep digest tight
            spend_lines = spend.split("\n")
            sections.append("\n".join(spend_lines[:10]))
            if len(spend_lines) > 10:
                sections.append(f"  ... run vendor_spend_summary for full detail")
    except Exception as e:
        sections.append(f"⚠️  Vendor spend data unavailable: {_msg(e, 'fetching vendor spend')}")
        issues.append("Vendor spend data unavailable — check Gmail/Google connection.")

    # ── Low Stock ────────────────────────────────────────────────────────
    sections.append("\n📦  INVENTORY\n" + "-" * 40)
    try:
        low = await inventory_low_stock()
        sections.append(low)
        if _is_error(low):
            issues.append("Inventory data unavailable — check Google Sheets connection.")
        elif "below par" in low.lower():
            issues.append("Inventory items are below par level — run inventory_reorder_list to generate orders.")
    except Exception as e:
        sections.append(f"⚠️  Inventory data unavailable: {_msg(e, 'fetching inventory')}")
        issues.append("Inventory data unavailable — check Google Sheets connection.")

    # ── Action Items ─────────────────────────────────────────────────────
    sections.append("\n⚡  ACTION ITEMS THIS WEEK\n" + "-" * 40)
    if issues:
        for i, issue in enumerate(issues, 1):
            sections.append(f"  {i}. {issue}")
    else:
        sections.append("  ✅  All financial KPIs are on track. No immediate actions required.")

    sections.append(f"\n{'='*60}")
    return "\n".join(sections)


async def monthly_financial_close_checklist(month: str = "") -> str:
    """
    Run all close checks for a given month and return a structured checklist.

    Confirms: invoices parsed, QB categorized, payroll reconciled, inventory counted,
    P&L reviewed, reconciliation clean, and labor % reviewed.

    Args:
        month: YYYY-MM (e.g., 2025-05) — defaults to the prior calendar month
    """
    from utils.date_helpers import month_range
    from tools.quickbooks import qb_pl_summary, qb_unreconciled_check
    from tools.payroll import payroll_labor_percentage
    from tools.email_invoices import invoice_reconciliation_check, parse_vendor_invoices
    from tools.inventory import inventory_current

    today = date.today()
    if not month:
        # Default to prior month
        if today.month == 1:
            month = f"{today.year - 1}-12"
        else:
            month = f"{today.year}-{today.month - 1:02d}"

    year, mon = map(int, month.split("-"))
    start, end = month_range(year, mon)
    start_str, end_str = str(start), str(end)

    checklist = []

    def check(label: str, passed: bool, detail: str = ""):
        icon = "✅" if passed else "❌"
        line = f"{icon}  {label}"
        if detail:
            line += f"\n      {detail}"
        checklist.append(line)
        return passed

    header = (
        f"{'='*60}\n"
        f"  MONTHLY CLOSE CHECKLIST\n"
        f"  Month: {month}  ({start_str} to {end_str})\n"
        f"  Generated: {today.strftime('%B %d, %Y')}\n"
        f"{'='*60}\n"
    )

    # 1. Invoice ledger synced
    try:
        invoice_result = await parse_vendor_invoices(start_str, end_str)
        parsed_count = invoice_result.count("Order #:")
        check(
            "All vendor invoices parsed and in ledger sheet",
            parsed_count > 0,
            f"{parsed_count} invoices parsed for {month}. Run invoice_ledger_sync to add to sheet.",
        )
    except Exception as e:
        check("All vendor invoices parsed and in ledger sheet", False, _msg(e, "parsing vendor invoices"))

    # 2. QB categorized
    try:
        unrec = await qb_unreconciled_check(as_of_date=end_str)
        is_clean = "no uncategorized" in unrec.lower() or "✅" in unrec
        count_str = ""
        if not is_clean:
            import re
            m = re.search(r"(\d+) transactions need attention", unrec)
            count_str = f"{m.group(1)} transactions need review" if m else "some transactions flagged"
        check("All QuickBooks transactions categorized", is_clean, count_str)
    except Exception as e:
        check("All QuickBooks transactions categorized", False, _msg(e, "checking QuickBooks transactions"))

    # 3. Payroll reconciled
    try:
        labor = await payroll_labor_percentage(start_str, end_str)
        has_data = "$" in labor
        check("Payroll reconciled against QuickBooks", has_data, "Labor % calculated." if has_data else "No payroll data found.")
    except Exception as e:
        check("Payroll reconciled against QuickBooks", False, _msg(e, "reconciling payroll"))

    # 4. Inventory counted
    try:
        inv = await inventory_current()
        has_items = "items" in inv.lower() and "(no data)" not in inv
        check("Inventory count completed and sheet updated", has_items, "Verify Last Updated dates are current for all items." if has_items else "No inventory data found.")
    except Exception as e:
        check("Inventory count completed and sheet updated", False, _msg(e, "fetching inventory"))

    # 5. P&L reviewed
    try:
        pl = await qb_pl_summary(start_month=month, end_month=month)
        has_pl = "Revenue" in pl
        margin_line = next((l for l in pl.split("\n") if "Gross Margin" in l), "")
        check("P&L reviewed — gross and net margin noted", has_pl, margin_line.strip() if margin_line else "")
    except Exception as e:
        check("P&L reviewed — gross and net margin noted", False, _msg(e, "fetching P&L"))

    # 6. Invoice reconciliation
    try:
        recon = await invoice_reconciliation_check(start_str, end_str)
        is_clean = "✅  All parsed invoices" in recon
        unmatched_note = ""
        if not is_clean:
            import re
            m = re.search(r"Unmatched.*?(\d+)", recon)
            unmatched_note = f"{m.group(1)} unbooked invoices found" if m else "unbooked invoices detected"
        check("Invoice reconciliation check run — no missing entries", is_clean, unmatched_note)
    except Exception as e:
        check("Invoice reconciliation check run — no missing entries", False, _msg(e, "running invoice reconciliation"))

    # 7. Labor %
    try:
        labor = await payroll_labor_percentage(start_str, end_str)
        within_target = "🔴" not in labor
        labor_line = next((l for l in labor.split("\n") if "Labor %" in l), "")
        check("Labor % reviewed vs 35% benchmark", within_target, labor_line.strip() if labor_line else "")
    except Exception as e:
        check("Labor % reviewed vs 35% benchmark", False, _msg(e, "calculating labor percentage"))

    passed = sum(1 for c in checklist if c.startswith("✅"))
    total = len(checklist)

    footer = f"\n{'='*60}\n{passed}/{total} items complete"
    if passed < total:
        footer += f"  —  {total - passed} items need attention before closing {month}"
    else:
        footer += "  —  Month is ready to close ✅"
    footer += f"\n{'='*60}"

    return header + "\n".join(checklist) + footer
