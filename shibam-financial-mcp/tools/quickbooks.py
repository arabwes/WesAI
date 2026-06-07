"""QuickBooks financial detail MCP tools — 6 tools covering transactions, receipts, P&L, vendor spend, reconciliation, and cash flow."""
import logging
from datetime import date
from typing import Optional
from clients.quickbooks_client import qb_query, qb_report, qb_get
from utils.date_helpers import to_start_end, qb_date
from utils.kpi_status import gross_margin_status
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)


@api_retry()
async def qb_transaction_detail(
    start_date: str,
    end_date: str,
    category: str = "",
    vendor: str = "",
) -> str:
    """
    Fetch all QuickBooks transactions for a date range with full detail.

    Returns date, vendor/payee, category, amount, payment method, memo,
    and whether a receipt is attached for each transaction.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        category:   optional — filter to a specific expense category/account name
        vendor:     optional — filter to a specific vendor/payee name
    """
    try:
        sql = (
            f"SELECT * FROM Purchase WHERE TxnDate >= '{start_date}' AND TxnDate <= '{end_date}' "
            "ORDERBY TxnDate DESC MAXRESULTS 500"
        )
        purchases = qb_query(sql)

        rows = []
        for p in purchases:
            payee_ref = p.get("EntityRef", {})
            payee = payee_ref.get("name", "Unknown")
            if vendor and vendor.lower() not in payee.lower():
                continue

            total = float(p.get("TotalAmt", 0))
            txn_date = p.get("TxnDate", "")
            memo = p.get("PrivateNote", "") or p.get("Memo", "") or ""
            payment_method = p.get("PaymentType", "")

            # Get line items for category detail
            lines_data = p.get("Line", [])
            categories = set()
            for line in lines_data:
                acct = line.get("AccountBasedExpenseLineDetail", {}).get("AccountRef", {})
                if acct.get("name"):
                    categories.add(acct["name"])
            cat_str = ", ".join(categories) if categories else "Uncategorized"

            if category and category.lower() not in cat_str.lower():
                continue

            rows.append({
                "Date": txn_date,
                "Vendor": payee[:30],
                "Category": cat_str[:35],
                "Amount": fmt_currency(total),
                "Method": payment_method,
                "Memo": memo[:40],
            })

        if not rows:
            return f"No QuickBooks transactions found for {start_date} to {end_date}."

        total_amount = sum(float(p.get("TotalAmt", 0)) for p in purchases)
        cols = ["Date", "Vendor", "Category", "Amount", "Method", "Memo"]
        return (
            f"QuickBooks Transaction Detail — {start_date} to {end_date}\n"
            f"Total: {fmt_currency(total_amount)}  |  Transactions: {len(rows)}\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        logger.error("qb_transaction_detail failed: %s", e)
        return f"Error fetching QuickBooks transactions: {e}"


@api_retry()
async def qb_receipt_attachments(start_date: str, end_date: str) -> str:
    """
    List QuickBooks transactions that have receipt attachments, and flag those that don't.

    Use case: verify all major purchases have receipts on file.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    try:
        # Fetch attachments via Attachable resource
        sql = (
            f"SELECT * FROM Attachable WHERE TxnDate >= '{start_date}' "
            f"AND TxnDate <= '{end_date}' MAXRESULTS 500"
        )
        # QuickBooks doesn't support date filters on Attachable directly — fetch all recent
        attachables = qb_query("SELECT * FROM Attachable MAXRESULTS 200")

        # Build a set of transaction IDs that have attachments
        txn_ids_with_attachments = set()
        for a in attachables:
            for ref in a.get("AttachableRef", []):
                txn_id = ref.get("EntityRef", {}).get("value")
                if txn_id:
                    txn_ids_with_attachments.add(txn_id)

        # Fetch purchases in range
        purchases = qb_query(
            f"SELECT * FROM Purchase WHERE TxnDate >= '{start_date}' AND TxnDate <= '{end_date}' "
            "ORDERBY TotalAmt DESC MAXRESULTS 200"
        )

        with_receipt = []
        without_receipt = []
        for p in purchases:
            txn_id = p.get("Id", "")
            payee = p.get("EntityRef", {}).get("name", "Unknown")
            amount = float(p.get("TotalAmt", 0))
            txn_date = p.get("TxnDate", "")
            entry = {"Date": txn_date, "Vendor": payee[:35], "Amount": fmt_currency(amount)}
            if txn_id in txn_ids_with_attachments:
                with_receipt.append(entry)
            else:
                without_receipt.append(entry)

        cols = ["Date", "Vendor", "Amount"]
        lines = [
            f"QuickBooks Receipt Attachments — {start_date} to {end_date}",
            f"",
            f"✅  With receipt:    {len(with_receipt)} transactions",
            f"❌  Missing receipt: {len(without_receipt)} transactions",
        ]
        if without_receipt:
            lines += [
                f"",
                f"Transactions MISSING receipts (add these in QuickBooks):",
                fmt_table(without_receipt, cols),
            ]

        return "\n".join(lines)

    except Exception as e:
        logger.error("qb_receipt_attachments failed: %s", e)
        return f"Error fetching QuickBooks receipt attachments: {e}"


@api_retry()
async def qb_pl_summary(
    start_month: str = "",
    end_month: str = "",
) -> str:
    """
    Fetch QuickBooks Profit & Loss by month.

    Returns total revenue, COGS, gross profit, gross margin %, operating expenses
    by category, net profit, and net margin %.

    Args:
        start_month: YYYY-MM (e.g., 2025-01) — defaults to current month
        end_month:   YYYY-MM — defaults to current month
    """
    try:
        today = date.today()
        if not start_month:
            start_month = today.strftime("%Y-%m")
        if not end_month:
            end_month = today.strftime("%Y-%m")

        start_date = f"{start_month}-01"
        # Get end of end_month
        year, month = map(int, end_month.split("-"))
        from utils.date_helpers import month_range
        _, last_day = month_range(year, month)
        end_date = str(last_day)

        report = qb_report("ProfitAndLoss", params={
            "start_date": start_date,
            "end_date": end_date,
            "summarize_column_by": "Month",
            "minorversion": "65",
        })

        # Navigate the QuickBooks P&L report JSON structure
        rows = report.get("Rows", {}).get("Row", [])

        revenue = cogs = gross_profit = net_income = 0.0
        opex_lines = []

        def extract_total(row_data):
            summary = row_data.get("Summary", {})
            cols = summary.get("ColData", [])
            for col in cols:
                try:
                    val = float(col.get("value", 0) or 0)
                    if val != 0:
                        return val
                except (ValueError, TypeError):
                    pass
            return 0.0

        for row in rows:
            group = row.get("group", "") or row.get("type", "")
            header = row.get("Header", {}).get("ColData", [{}])[0].get("value", "")
            total = extract_total(row)

            if "Income" in group or "Revenue" in header:
                revenue = total
            elif "CostOfGoodsSold" in group or "COGS" in header or "Cost of" in header:
                cogs = abs(total)
            elif "Expenses" in group or "Operating" in group:
                # Get sub-rows for opex breakdown
                for sub in row.get("Rows", {}).get("Row", []):
                    sub_header = sub.get("Header", {}).get("ColData", [{}])[0].get("value", "")
                    sub_total = extract_total(sub)
                    if sub_header and sub_total != 0:
                        opex_lines.append((sub_header, abs(sub_total)))
            elif "NetIncome" in group or "Net Income" in header:
                net_income = total

        gross_profit = revenue - cogs
        gross_margin = (gross_profit / revenue * 100) if revenue else 0
        total_opex = sum(v for _, v in opex_lines)
        net_margin = (net_income / revenue * 100) if revenue else 0

        gm_status = gross_margin_status(gross_margin)

        lines = [
            f"QuickBooks P&L Summary — {start_month} to {end_month}",
            f"",
            f"Revenue:           {fmt_currency(revenue)}",
            f"COGS:              {fmt_currency(cogs)}",
            f"Gross Profit:      {fmt_currency(gross_profit)}",
            f"{gm_status}  Gross Margin:   {fmt_pct(gross_margin)}  (target: ≥65%)",
            f"",
            f"Operating Expenses:  {fmt_currency(total_opex)}",
        ]
        for name, amount in sorted(opex_lines, key=lambda x: -x[1])[:10]:
            lines.append(f"  {name:<35} {fmt_currency(amount)}")

        net_status = "🟢" if net_income >= 0 else "🔴"
        lines += [
            f"",
            f"{net_status}  Net Profit:     {fmt_currency(net_income)}  ({fmt_pct(net_margin)} margin)",
        ]

        return "\n".join(lines)

    except Exception as e:
        logger.error("qb_pl_summary failed: %s", e)
        return f"Error fetching QuickBooks P&L: {e}"


@api_retry()
async def qb_vendor_spend(
    start_date: str,
    end_date: str,
    top_n: int = 20,
) -> str:
    """
    Fetch total QuickBooks spend grouped by vendor, sorted by spend descending.

    Use case: identify largest cost centers, track vendor spend trends month over month.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        top_n:      number of top vendors to show (default 20)
    """
    try:
        purchases = qb_query(
            f"SELECT * FROM Purchase WHERE TxnDate >= '{start_date}' AND TxnDate <= '{end_date}' "
            "MAXRESULTS 500"
        )
        bills = qb_query(
            f"SELECT * FROM Bill WHERE TxnDate >= '{start_date}' AND TxnDate <= '{end_date}' "
            "MAXRESULTS 500"
        )

        vendor_totals: dict = {}
        for txn in purchases + bills:
            payee = txn.get("EntityRef", {}).get("name", "Unknown")
            amount = float(txn.get("TotalAmt", 0))
            vendor_totals[payee] = vendor_totals.get(payee, 0.0) + amount

        if not vendor_totals:
            return f"No QuickBooks vendor spend found for {start_date} to {end_date}."

        total_spend = sum(vendor_totals.values())
        sorted_vendors = sorted(vendor_totals.items(), key=lambda x: -x[1])[:top_n]

        rows = []
        for i, (vendor, amount) in enumerate(sorted_vendors, 1):
            pct = (amount / total_spend * 100) if total_spend else 0
            rows.append({
                "Rank": str(i),
                "Vendor": vendor[:40],
                "Total Spend": fmt_currency(amount),
                "% of Total": fmt_pct(pct, 1),
            })

        cols = ["Rank", "Vendor", "Total Spend", "% of Total"]
        return (
            f"QuickBooks Vendor Spend — {start_date} to {end_date}\n"
            f"Total spend: {fmt_currency(total_spend)}  |  Showing top {len(rows)} of {len(vendor_totals)} vendors\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        logger.error("qb_vendor_spend failed: %s", e)
        return f"Error fetching QuickBooks vendor spend: {e}"


@api_retry()
async def qb_unreconciled_check(as_of_date: str = "") -> str:
    """
    List QuickBooks transactions that are uncategorized, unreviewed, or flagged.

    Use case: weekly bookkeeping hygiene check before month-end.

    Args:
        as_of_date: YYYY-MM-DD — defaults to today
    """
    try:
        if not as_of_date:
            as_of_date = str(date.today())

        # Find purchases without an AccountRef (uncategorized)
        uncategorized = qb_query(
            f"SELECT * FROM Purchase WHERE TxnDate <= '{as_of_date}' MAXRESULTS 200"
        )

        flagged = []
        for p in uncategorized:
            lines_data = p.get("Line", [])
            has_category = any(
                line.get("AccountBasedExpenseLineDetail", {}).get("AccountRef")
                for line in lines_data
            )
            memo = p.get("PrivateNote", "") or ""
            is_flagged = "review" in memo.lower() or "check" in memo.lower() or "?" in memo

            if not has_category or is_flagged:
                payee = p.get("EntityRef", {}).get("name", "Unknown")
                amount = float(p.get("TotalAmt", 0))
                flagged.append({
                    "Date": p.get("TxnDate", ""),
                    "Vendor": payee[:35],
                    "Amount": fmt_currency(amount),
                    "Issue": "Uncategorized" if not has_category else "Flagged in memo",
                })

        if not flagged:
            return f"✅  QuickBooks check complete — no uncategorized or flagged transactions as of {as_of_date}."

        cols = ["Date", "Vendor", "Amount", "Issue"]
        return (
            f"QuickBooks Unreconciled Check — as of {as_of_date}\n"
            f"⚠️  {len(flagged)} transactions need attention:\n\n"
            + fmt_table(flagged, cols)
            + "\n\nAction: open QuickBooks → Banking → Transactions → review each item."
        )

    except Exception as e:
        logger.error("qb_unreconciled_check failed: %s", e)
        return f"Error checking QuickBooks unreconciled transactions: {e}"


@api_retry()
async def qb_cashflow_summary(weeks: int = 8) -> str:
    """
    Show cash in vs cash out by week for a rolling period, flagging negative cash weeks.

    Use case: cash flow planning and identifying thin weeks.

    Args:
        weeks: number of rolling weeks to show (default 8)
    """
    try:
        from datetime import timedelta
        today = date.today()
        start = today - timedelta(weeks=weeks)

        report = qb_report("CashFlow", params={
            "start_date": str(start),
            "end_date": str(today),
            "summarize_column_by": "Week",
        })

        rows_data = report.get("Rows", {}).get("Row", [])

        operating_in = 0.0
        operating_out = 0.0
        net_change = 0.0

        for row in rows_data:
            header = row.get("Header", {}).get("ColData", [{}])[0].get("value", "")
            total_col = row.get("Summary", {}).get("ColData", [])
            val = 0.0
            for col in total_col:
                try:
                    val = float(col.get("value", 0) or 0)
                    if val != 0:
                        break
                except (ValueError, TypeError):
                    pass

            if "Operating" in header and val > 0:
                operating_in += val
            elif "Operating" in header and val < 0:
                operating_out += abs(val)
            elif "Net" in header:
                net_change = val

        net_status = "🟢" if net_change >= 0 else "🔴"
        lines = [
            f"QuickBooks Cash Flow Summary — last {weeks} weeks",
            f"",
            f"Cash In (Operating):   {fmt_currency(operating_in)}",
            f"Cash Out (Operating):  {fmt_currency(operating_out)}",
            f"{net_status}  Net Cash Change:   {fmt_currency(net_change)}",
            f"",
        ]

        if net_change < 0:
            lines.append("⚠️  Negative net cash flow this period. Review expenses against revenue trend.")
        else:
            lines.append("✅  Positive net cash flow this period.")

        lines += [
            f"",
            f"Tip: For week-by-week detail, open QuickBooks → Reports → Cash Flow Statement.",
        ]

        return "\n".join(lines)

    except Exception as e:
        logger.error("qb_cashflow_summary failed: %s", e)
        return f"Error fetching QuickBooks cash flow: {e}"
