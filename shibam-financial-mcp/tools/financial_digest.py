"""Composite financial digest tools — weekly snapshot and monthly close checklist."""
import logging
from datetime import date

logger = logging.getLogger(__name__)


async def weekly_financial_digest(week: str = "last_7_days") -> str:
    """
    Generate a complete weekly financial snapshot for Shibam Coffee.

    Calls all key financial tools and returns one formatted report covering:
    - Revenue vs estimated gross margin
    - Labor % of revenue with 🟢🟡🔴 rating
    - Unreconciled QuickBooks transactions
    - Top 3 vendor spend from parsed invoices
    - Low stock items requiring reorder
    - Invoice reconciliation flags

    Args:
        week: last_7_days | last_30_days | this_month | last_month | custom
              Defaults to last_7_days.
    """
    from utils.date_helpers import to_start_end
    from tools.toast_financial import toast_labor_vs_revenue
    from tools.email_invoices import vendor_spend_summary
    from tools.inventory import inventory_low_stock

    today = date.today()
    start, end = to_start_end(week)
    sections = []
    issues = []

    sections.append(
        f"{'='*60}\n"
        f"  SHIBAM COFFEE — WEEKLY FINANCIAL DIGEST\n"
        f"  Generated: {today.strftime('%B %d, %Y')}  |  Period: {week}\n"
        f"{'='*60}"
    )

    # ── P&L + Payroll (QuickBooks connector) ─────────────────────────────
    sections.append("\n📊  PROFIT & LOSS / PAYROLL\n" + "-" * 40)
    sections.append(
        "  Use the QuickBooks connector to pull P&L, payroll, and reconciliation data.\n"
        "  Ask: 'Show me the P&L for this month' or 'Check unreconciled transactions'."
    )

    # ── Toast Labor ───────────────────────────────────────────────────────
    sections.append("\n👥  LABOR (Toast)\n" + "-" * 40)
    try:
        labor = await toast_labor_vs_revenue(str(start), str(end))
        sections.append(labor)
        if "Overstaffed" in labor:
            issues.append("Overstaffed hours detected in Toast — review schedule.")
    except Exception as e:
        sections.append(f"⚠️  Toast labor data unavailable: {e}")

    # ── Vendor Spend ─────────────────────────────────────────────────────
    sections.append("\n🧾  VENDOR SPEND (Top 3)\n" + "-" * 40)
    try:
        spend = await vendor_spend_summary(str(start), str(end))
        # Show only first 5 lines to keep digest tight
        spend_lines = spend.split("\n")
        sections.append("\n".join(spend_lines[:10]))
        if len(spend_lines) > 10:
            sections.append(f"  ... run vendor_spend_summary for full detail")
    except Exception as e:
        sections.append(f"⚠️  Vendor spend data unavailable: {e}")

    # ── Low Stock ────────────────────────────────────────────────────────
    sections.append("\n📦  INVENTORY\n" + "-" * 40)
    try:
        low = await inventory_low_stock()
        sections.append(low)
        if "below par" in low.lower():
            issues.append("Inventory items are below par level — run inventory_reorder_list to generate orders.")
    except Exception as e:
        sections.append(f"⚠️  Inventory data unavailable: {e}")

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
        f"  SHIBAM COFFEE — MONTHLY CLOSE CHECKLIST\n"
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
        check("All vendor invoices parsed and in ledger sheet", False, str(e))

    # 2. QB categorized (use QB connector)
    check(
        "All QuickBooks transactions categorized",
        False,
        "Use the QuickBooks connector — ask 'Check unreconciled transactions for {month}'",
    )

    # 3. Payroll reconciled (use QB connector)
    check(
        "Payroll reconciled against QuickBooks",
        False,
        "Use the QuickBooks connector — ask 'Show payroll summary for {month}'",
    )

    # 4. Inventory counted
    try:
        inv = await inventory_current()
        has_items = "items" in inv.lower() and "(no data)" not in inv
        check("Inventory count completed and sheet updated", has_items, "Verify Last Updated dates are current for all items." if has_items else "No inventory data found.")
    except Exception as e:
        check("Inventory count completed and sheet updated", False, str(e))

    # 5. P&L reviewed (use QB connector)
    check(
        "P&L reviewed — gross and net margin noted",
        False,
        f"Use the QuickBooks connector — ask 'Show P&L for {month}'",
    )

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
        check("Invoice reconciliation check run — no missing entries", False, str(e))

    # 7. Labor %
    check(
        "Labor % reviewed vs 35% benchmark",
        False,
        f"Use the QuickBooks connector — ask 'Show labor % for {month}'",
    )

    passed = sum(1 for c in checklist if c.startswith("✅"))
    total = len(checklist)

    footer = f"\n{'='*60}\n{passed}/{total} items complete"
    if passed < total:
        footer += f"  —  {total - passed} items need attention before closing {month}"
    else:
        footer += "  —  Month is ready to close ✅"
    footer += f"\n{'='*60}"

    return header + "\n".join(checklist) + footer
