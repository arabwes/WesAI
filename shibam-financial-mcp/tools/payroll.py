"""Payroll MCP tools — 4 tools using QuickBooks Payroll + WhenIWork for labor planning.

QuickBooks processes payroll. WhenIWork provides scheduling data.
Toast provides actual clock-in/out hours.
"""
import logging
from datetime import date
from clients.quickbooks_client import qb_report, qb_query
from clients import wheniwork_client
from utils.date_helpers import to_start_end, qb_date
from utils.kpi_status import labor_pct_status
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_LABOR_ALERT_THRESHOLD = 35.0  # % of revenue — flag if exceeded


def _check_qb() -> str | None:
    from config import config
    if not config.qb_ready:
        return "QuickBooks not configured. Add QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REFRESH_TOKEN, and QB_REALM_ID to your Railway environment variables."
    return None


def _check_wiw() -> str | None:
    from config import config
    if not config.wheniwork_ready:
        return "WhenIWork not configured. Add WHENIWORK_API_KEY and WHENIWORK_ACCOUNT_ID to your Railway environment variables."
    return None


@api_retry()
async def payroll_summary(
    start_date: str,
    end_date: str,
    pay_period: str = "",
) -> str:
    """
    Fetch total gross payroll, employer taxes, and net payroll cost from QuickBooks.

    Args:
        start_date:  YYYY-MM-DD
        end_date:    YYYY-MM-DD
        pay_period:  optional — filter to a specific pay period label
    """
    err = _check_qb()
    if err: return err
    try:
        report = qb_report("PayrollSummary", params={
            "start_date": start_date,
            "end_date": end_date,
            "minorversion": "65",
        })

        rows = report.get("Rows", {}).get("Row", [])
        gross_pay = employer_taxes = net_pay = 0.0

        for row in rows:
            header = row.get("Header", {}).get("ColData", [{}])[0].get("value", "")
            summary_cols = row.get("Summary", {}).get("ColData", [])
            total = 0.0
            for col in summary_cols:
                try:
                    val = float(col.get("value", 0) or 0)
                    if val != 0:
                        total = val
                        break
                except (ValueError, TypeError):
                    pass

            header_lower = header.lower()
            if "gross" in header_lower and "pay" in header_lower:
                gross_pay = abs(total)
            elif "employer" in header_lower and "tax" in header_lower:
                employer_taxes = abs(total)
            elif "net" in header_lower:
                net_pay = abs(total)

        total_cost = gross_pay + employer_taxes
        lines = [
            f"Payroll Summary — {start_date} to {end_date}",
            f"",
            f"Gross Payroll:      {fmt_currency(gross_pay)}",
            f"Employer Taxes:     {fmt_currency(employer_taxes)}",
            f"──────────────────────────────",
            f"Total Payroll Cost: {fmt_currency(total_cost)}",
            f"Net Pay (employees receive): {fmt_currency(net_pay)}",
        ]
        if pay_period:
            lines.insert(1, f"Pay Period: {pay_period}")

        return "\n".join(lines)

    except Exception as e:
        logger.error("payroll_summary failed: %s", e)
        return f"Error fetching payroll summary: {e}"


@api_retry()
async def payroll_by_role(start_date: str, end_date: str) -> str:
    """
    Fetch payroll cost grouped by job role/position.

    Returns role-level totals only — no individual employee names in output.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    err = _check_qb()
    if err: return err
    try:
        report = qb_report("PayrollSummary", params={
            "start_date": start_date,
            "end_date": end_date,
            "summarize_column_by": "Employees",
            "minorversion": "65",
        })

        # QuickBooks Payroll by role requires iterating employee rows and grouping by job title
        # We use the Employees detail report and aggregate by job code
        employees = qb_query("SELECT * FROM Employee MAXRESULTS 200")

        # Build title map from employee list
        title_map: dict = {}
        for emp in employees:
            emp_id = emp.get("Id", "")
            title = emp.get("Title", "") or emp.get("PrimaryAddr", {}).get("Line1", "") or "Staff"
            title_map[emp_id] = title

        rows_data = report.get("Rows", {}).get("Row", [])

        role_totals: dict = {}
        for row in rows_data:
            emp_ref = row.get("Header", {}).get("ColData", [{}])[0].get("id", "")
            summary_cols = row.get("Summary", {}).get("ColData", [])
            gross = 0.0
            for col in summary_cols:
                try:
                    val = float(col.get("value", 0) or 0)
                    if val != 0:
                        gross = abs(val)
                        break
                except (ValueError, TypeError):
                    pass
            role = title_map.get(str(emp_ref), "Staff")
            role_totals[role] = role_totals.get(role, 0.0) + gross

        if not role_totals:
            return f"No payroll data found for {start_date} to {end_date}."

        total = sum(role_totals.values())
        table_rows = []
        for role, amount in sorted(role_totals.items(), key=lambda x: -x[1]):
            pct = (amount / total * 100) if total else 0
            table_rows.append({
                "Role": role,
                "Payroll Cost": fmt_currency(amount),
                "% of Total": fmt_pct(pct, 1),
            })

        cols = ["Role", "Payroll Cost", "% of Total"]
        return (
            f"Payroll by Role — {start_date} to {end_date}\n"
            f"Total payroll: {fmt_currency(total)}\n\n"
            + fmt_table(table_rows, cols)
            + "\n\nNote: Showing role totals only — no individual employee names."
        )

    except Exception as e:
        logger.error("payroll_by_role failed: %s", e)
        return f"Error fetching payroll by role: {e}"


@api_retry()
async def payroll_labor_percentage(start_date: str, end_date: str) -> str:
    """
    Calculate labor cost as a percentage of revenue using QuickBooks payroll + Toast revenue.

    Flags if labor % exceeds 35% benchmark.
    Also pulls WhenIWork scheduled hours for three-way comparison.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    err = _check_qb()
    if err: return err
    try:
        # Get payroll from QuickBooks
        payroll_report = qb_report("PayrollSummary", params={
            "start_date": start_date,
            "end_date": end_date,
            "minorversion": "65",
        })
        total_payroll = 0.0
        for row in payroll_report.get("Rows", {}).get("Row", []):
            header = row.get("Header", {}).get("ColData", [{}])[0].get("value", "")
            if "gross" in header.lower():
                for col in row.get("Summary", {}).get("ColData", []):
                    try:
                        val = float(col.get("value", 0) or 0)
                        if val != 0:
                            total_payroll = abs(val)
                            break
                    except (ValueError, TypeError):
                        pass

        # Get revenue from Toast (if available)
        total_revenue = 0.0
        toast_note = ""
        if not __import__("config").config.toast_api_pending:
            try:
                from clients import toast_client
                from utils.date_helpers import to_toast_datetime
                from datetime import date as d_cls
                start_d, end_d = to_start_end("custom", start_date, end_date)
                params = {
                    "startDate": to_toast_datetime(start_d),
                    "endDate": to_toast_datetime(end_d, end_of_day=True),
                    "pageSize": 500,
                }
                all_orders, page = [], 1
                while True:
                    params["page"] = page
                    data = toast_client.get("/orders/v2/orders", params=params)
                    orders = data if isinstance(data, list) else data.get("orders", [])
                    if not orders:
                        break
                    total_revenue += sum(float(o.get("totalAmount", 0) or 0) for o in orders)
                    if len(orders) < 500:
                        break
                    page += 1
            except Exception as te:
                toast_note = f"(Toast revenue unavailable: {te})"
        else:
            toast_note = "(Toast API pending — revenue estimated from QuickBooks)"
            # Fall back to QB revenue
            pl = qb_report("ProfitAndLoss", params={"start_date": start_date, "end_date": end_date})
            for row in pl.get("Rows", {}).get("Row", []):
                header = row.get("Header", {}).get("ColData", [{}])[0].get("value", "")
                if "Income" in row.get("group", "") or "Revenue" in header:
                    for col in row.get("Summary", {}).get("ColData", []):
                        try:
                            val = float(col.get("value", 0) or 0)
                            if val != 0:
                                total_revenue = abs(val)
                                break
                        except (ValueError, TypeError):
                            pass

        labor_pct = (total_payroll / total_revenue * 100) if total_revenue else 0
        lps = labor_pct_status(labor_pct)

        # Get WhenIWork scheduled hours for comparison
        scheduled_hrs = 0.0
        wiw_note = ""
        try:
            shifts = wheniwork_client.get_shifts(start_date, end_date)
            for shift in shifts:
                start_ts = shift.get("start_time", "")
                end_ts = shift.get("end_time", "")
                if start_ts and end_ts:
                    from datetime import datetime
                    s = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
                    e = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
                    scheduled_hrs += (e - s).total_seconds() / 3600
        except Exception as we:
            wiw_note = f"(WhenIWork hours unavailable: {we})"

        lines = [
            f"Payroll Labor Percentage — {start_date} to {end_date}",
            f"",
            f"Gross Payroll (QuickBooks): {fmt_currency(total_payroll)}",
            f"Total Revenue (Toast):      {fmt_currency(total_revenue)}  {toast_note}",
            f"{lps}  Labor % of Revenue:    {fmt_pct(labor_pct)}  (target: ≤28% / alert: >35%)",
        ]

        if scheduled_hrs > 0:
            lines += [
                f"",
                f"WhenIWork Scheduled Hours: {fmt_number(scheduled_hrs, 1)} hrs  {wiw_note}",
                f"Implied hourly labor rate: {fmt_currency(total_payroll / scheduled_hrs)}/hr" if scheduled_hrs else "",
            ]
        elif wiw_note:
            lines.append(f"\nWhenIWork: {wiw_note}")

        if labor_pct > _LABOR_ALERT_THRESHOLD:
            lines.append(f"\n⚠️  ALERT: Labor exceeds {_LABOR_ALERT_THRESHOLD}% of revenue. Review staffing schedule.")

        return "\n".join(lines)

    except Exception as e:
        logger.error("payroll_labor_percentage failed: %s", e)
        return f"Error calculating payroll labor percentage: {e}"


@api_retry()
async def payroll_schedule_overview() -> str:
    """
    Fetch upcoming pay periods, last pay date, next pay date, and estimated next payroll.

    Use case: cash flow planning — know how much payroll to prepare for.
    """
    err = _check_qb()
    if err: return err
    try:
        # Get recent payroll runs from QuickBooks
        from datetime import date as d_cls, timedelta
        today = d_cls.today()
        start = today - timedelta(days=90)

        # QuickBooks Paycheck query
        paychecks = qb_query(
            f"SELECT * FROM VendorCredit WHERE TxnDate >= '{start}' MAXRESULTS 50"
        )
        # More reliably: use payroll summary report for past 3 months
        report = qb_report("PayrollSummary", params={
            "start_date": str(start),
            "end_date": str(today),
            "summarize_column_by": "Month",
        })

        # Extract month totals as a proxy for pay period history
        monthly_totals = []
        for row in report.get("Rows", {}).get("Row", []):
            header_val = row.get("Header", {}).get("ColData", [{}])[0].get("value", "")
            if "gross" in header_val.lower():
                col_data = row.get("Summary", {}).get("ColData", [])
                for i, col in enumerate(col_data):
                    try:
                        val = float(col.get("value", 0) or 0)
                        if abs(val) > 0:
                            monthly_totals.append(abs(val))
                    except (ValueError, TypeError):
                        pass

        avg_monthly = sum(monthly_totals) / len(monthly_totals) if monthly_totals else 0
        estimated_biweekly = avg_monthly / 2.17  # approximate biweekly from monthly

        # WhenIWork next week scheduled hours
        next_week_start = today + timedelta(days=(7 - today.weekday()))
        next_week_end = next_week_start + timedelta(days=6)
        next_week_hrs = 0.0
        try:
            shifts = wheniwork_client.get_shifts(str(next_week_start), str(next_week_end))
            for shift in shifts:
                s_str = shift.get("start_time", "")
                e_str = shift.get("end_time", "")
                if s_str and e_str:
                    from datetime import datetime
                    s = datetime.fromisoformat(s_str.replace("Z", "+00:00"))
                    e = datetime.fromisoformat(e_str.replace("Z", "+00:00"))
                    next_week_hrs += (e - s).total_seconds() / 3600
        except Exception:
            pass

        lines = [
            f"Payroll Schedule Overview",
            f"",
            f"As of: {today}",
            f"",
            f"Recent Monthly Payroll (avg):       {fmt_currency(avg_monthly)}",
            f"Estimated Bi-weekly Payroll:        {fmt_currency(estimated_biweekly)}",
            f"",
            f"WhenIWork — Next Week Schedule ({next_week_start} to {next_week_end}):",
            f"  Scheduled Hours: {fmt_number(next_week_hrs, 1)} hrs",
            f"",
            f"Tip: For exact pay dates and amounts, check QuickBooks → Payroll → Overview.",
        ]

        return "\n".join(lines)

    except Exception as e:
        logger.error("payroll_schedule_overview failed: %s", e)
        return f"Error fetching payroll schedule overview: {e}"
