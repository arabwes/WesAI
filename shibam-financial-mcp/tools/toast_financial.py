"""Toast POS financial extension MCP tools — 5 tools for modifiers, labor, voids, and tips.
These complement the sales tools in shibam-marketing-mcp without duplicating them.
All tools respect the TOAST_API_PENDING flag.
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional
from clients import toast_client
from config import config
from utils.date_helpers import to_start_end, to_toast_datetime
from utils.kpi_status import labor_pct_status
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_PENDING_MSG = (
    "Toast API access is pending approval.\n"
    "Set TOAST_API_PENDING=false and add Toast credentials to enable these tools.\n"
    "Apply at: developers.toasttab.com"
)


def _check_pending() -> Optional[str]:
    return _PENDING_MSG if config.toast_api_pending else None


def _fetch_orders(start_date: str, end_date: str) -> list:
    from datetime import date
    start, end = to_start_end("custom", start_date, end_date)
    params = {
        "startDate": to_toast_datetime(start),
        "endDate": to_toast_datetime(end, end_of_day=True),
        "pageSize": 500,
    }
    all_orders, page = [], 1
    while True:
        params["page"] = page
        data = toast_client.get("/orders/v2/orders", params=params)
        orders = data if isinstance(data, list) else data.get("orders", [])
        if not orders:
            break
        all_orders.extend(orders)
        if len(orders) < 500:
            break
        page += 1
    return all_orders


@api_retry()
async def toast_modifier_revenue(start_date: str, end_date: str) -> str:
    """
    Fetch modifier and add-on sales detail from Toast.

    Returns modifier name, parent item, quantity sold, and revenue generated.
    Use case: understand true revenue from add-ons (extra shots, milk alternatives,
    flavor shots, size upgrades).

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        modifier_data: dict = defaultdict(lambda: {"qty": 0, "revenue": 0.0, "parent": ""})

        for order in orders:
            for check in order.get("checks", []):
                for selection in check.get("selections", []):
                    parent_name = selection.get("displayName", "Unknown")
                    for modifier in selection.get("modifiers", []):
                        mod_name = modifier.get("displayName", "Unknown modifier")
                        qty = int(modifier.get("quantity", 1) or 1)
                        price = float(modifier.get("preDiscountPrice", 0) or 0) * qty
                        key = mod_name
                        modifier_data[key]["qty"] += qty
                        modifier_data[key]["revenue"] += price
                        if not modifier_data[key]["parent"]:
                            modifier_data[key]["parent"] = parent_name

        if not modifier_data:
            return f"No modifier data found for {start_date} to {end_date}."

        rows = []
        total_mod_rev = 0.0
        for mod_name, data in sorted(modifier_data.items(), key=lambda x: -x[1]["revenue"]):
            total_mod_rev += data["revenue"]
            rows.append({
                "Modifier": mod_name[:35],
                "Common Parent": data["parent"][:25],
                "Qty Sold": fmt_number(data["qty"]),
                "Revenue": fmt_currency(data["revenue"]),
            })

        cols = ["Modifier", "Common Parent", "Qty Sold", "Revenue"]
        return (
            f"Toast Modifier Revenue — {start_date} to {end_date}\n"
            f"Total modifier revenue: {fmt_currency(total_mod_rev)}\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        logger.error("toast_modifier_revenue failed: %s", e)
        return f"Error fetching Toast modifier revenue: {e}"


@api_retry()
async def toast_labor_summary(start_date: str, end_date: str) -> str:
    """
    Fetch Toast labor summary — total hours, total cost, labor % of revenue, by day and role.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        from datetime import date
        start, end = to_start_end("custom", start_date, end_date)
        time_entries = toast_client.get("/labor/v1/timeEntries", params={
            "startDate": to_toast_datetime(start),
            "endDate": to_toast_datetime(end, end_of_day=True),
        })
        if isinstance(time_entries, dict):
            time_entries = time_entries.get("timeEntries", [])

        # Get revenue for the same period to calculate labor %
        orders = _fetch_orders(start_date, end_date)
        total_revenue = sum(float(o.get("totalAmount", 0) or 0) for o in orders)

        total_hours = 0.0
        total_cost = 0.0
        by_role: dict = defaultdict(lambda: {"hours": 0.0, "cost": 0.0})
        by_day: dict = defaultdict(lambda: {"hours": 0.0, "cost": 0.0})

        for entry in time_entries:
            in_dt = entry.get("inDate", "")
            out_dt = entry.get("outDate", "")
            if not in_dt or not out_dt:
                continue
            try:
                in_time = datetime.fromisoformat(in_dt.replace("Z", "+00:00"))
                out_time = datetime.fromisoformat(out_dt.replace("Z", "+00:00"))
                hours = (out_time - in_time).total_seconds() / 3600
                wages = float(entry.get("regularHours", hours) * float(entry.get("hourlyWage", 0) or 0))
                role = entry.get("jobCode", {}).get("title", "Unknown") if isinstance(entry.get("jobCode"), dict) else "Unknown"
                day = in_time.strftime("%a %m/%d")
                total_hours += hours
                total_cost += wages
                by_role[role]["hours"] += hours
                by_role[role]["cost"] += wages
                by_day[day]["hours"] += hours
                by_day[day]["cost"] += wages
            except Exception:
                continue

        labor_pct = (total_cost / total_revenue * 100) if total_revenue else 0
        lps = labor_pct_status(labor_pct)

        lines = [
            f"Toast Labor Summary — {start_date} to {end_date}",
            f"",
            f"Total Labor Hours:  {fmt_number(total_hours, 1)}",
            f"Total Labor Cost:   {fmt_currency(total_cost)}",
            f"Total Revenue:      {fmt_currency(total_revenue)}",
            f"{lps}  Labor % of Revenue: {fmt_pct(labor_pct)}  (target: ≤28% / alert: >35%)",
            f"",
            f"By Role:",
        ]
        for role, data in sorted(by_role.items(), key=lambda x: -x[1]["cost"]):
            lines.append(f"  {role:<25} {fmt_number(data['hours'], 1)} hrs  {fmt_currency(data['cost'])}")

        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_labor_summary failed: %s", e)
        return f"Error fetching Toast labor summary: {e}"


@api_retry()
async def toast_labor_vs_revenue(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Compare hourly revenue vs hourly labor cost for each day of the week.

    Identifies overstaffed and understaffed hours.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        orders = _fetch_orders(str(start), str(end))
        time_entries = toast_client.get("/labor/v1/timeEntries", params={
            "startDate": to_toast_datetime(start),
            "endDate": to_toast_datetime(end, end_of_day=True),
        })
        if isinstance(time_entries, dict):
            time_entries = time_entries.get("timeEntries", [])

        dow_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        revenue_by_dow: dict = defaultdict(float)
        labor_by_dow: dict = defaultdict(float)
        order_days: dict = defaultdict(int)

        for order in orders:
            amount = float(order.get("totalAmount", 0) or 0)
            opened = order.get("openedDate", "")
            if opened:
                dt = datetime.fromisoformat(opened.replace("Z", "+00:00"))
                revenue_by_dow[dt.weekday()] += amount
                order_days[dt.weekday()] += 1

        for entry in time_entries:
            in_dt = entry.get("inDate", "")
            out_dt = entry.get("outDate", "")
            if not in_dt or not out_dt:
                continue
            try:
                in_time = datetime.fromisoformat(in_dt.replace("Z", "+00:00"))
                out_time = datetime.fromisoformat(out_dt.replace("Z", "+00:00"))
                hours = (out_time - in_time).total_seconds() / 3600
                wage = float(entry.get("regularHours", hours) * float(entry.get("hourlyWage", 0) or 0))
                labor_by_dow[in_time.weekday()] += wage
            except Exception:
                continue

        rows = []
        for dow in range(7):
            rev = revenue_by_dow.get(dow, 0)
            labor = labor_by_dow.get(dow, 0)
            ratio = (labor / rev * 100) if rev else 0
            flag = ""
            if ratio > 40:
                flag = "⚠️ Overstaffed"
            elif ratio < 15 and rev > 0:
                flag = "✅ Efficient"
            rows.append({
                "Day": dow_names[dow],
                "Revenue": fmt_currency(rev),
                "Labor Cost": fmt_currency(labor),
                "Labor %": fmt_pct(ratio, 1),
                "Note": flag,
            })

        cols = ["Day", "Revenue", "Labor Cost", "Labor %", "Note"]
        return (
            f"Toast Labor vs Revenue by Day — {date_range} ({start} to {end})\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        logger.error("toast_labor_vs_revenue failed: %s", e)
        return f"Error fetching Toast labor vs revenue: {e}"


@api_retry()
async def toast_void_refund_summary(start_date: str, end_date: str) -> str:
    """
    Fetch all voided items and refunds from Toast — count, total value, reason codes.

    Use case: track waste, errors, and potential shrinkage.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        voids = []
        refunds = []

        for order in orders:
            for check in order.get("checks", []):
                # Check for refund at check level
                refund_amount = float(check.get("totalAmount", 0) or 0)
                if check.get("refundInfo"):
                    refunds.append({
                        "Date": order.get("openedDate", "")[:10],
                        "Amount": fmt_currency(abs(refund_amount)),
                        "Reason": str(check.get("refundInfo", {}).get("refundComment", "No reason given"))[:40],
                        "Type": "Refund",
                    })

                for selection in check.get("selections", []):
                    if selection.get("voidInfo"):
                        void_reason = selection.get("voidInfo", {}).get("voidReason", {})
                        reason = void_reason.get("englishName", "Unknown") if isinstance(void_reason, dict) else str(void_reason)
                        item_price = float(selection.get("preDiscountPrice", 0) or 0)
                        voids.append({
                            "Date": order.get("openedDate", "")[:10],
                            "Item": selection.get("displayName", "")[:30],
                            "Amount": fmt_currency(item_price),
                            "Reason": reason[:40],
                            "Type": "Void",
                        })

        total_void_value = sum(float(o.get("totalAmount", 0) or 0) for o in orders
                               if any(s.get("voidInfo") for c in o.get("checks", []) for s in c.get("selections", [])))
        total_refund_value = sum(abs(float(c.get("totalAmount", 0) or 0))
                                 for o in orders for c in o.get("checks", []) if c.get("refundInfo"))

        all_items = voids + refunds
        cols = ["Date", "Item", "Amount", "Reason", "Type"]
        lines = [
            f"Toast Void & Refund Summary — {start_date} to {end_date}",
            f"",
            f"Total Voids:   {len(voids)} items  (~{fmt_currency(total_void_value)})",
            f"Total Refunds: {len(refunds)} transactions  (~{fmt_currency(total_refund_value)})",
        ]
        if all_items:
            lines += ["", fmt_table(all_items[:50], cols)]
            if len(all_items) > 50:
                lines.append(f"... and {len(all_items) - 50} more. Check Toast for full detail.")

        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_void_refund_summary failed: %s", e)
        return f"Error fetching Toast void/refund summary: {e}"


@api_retry()
async def toast_tips_summary(start_date: str, end_date: str) -> str:
    """
    Fetch total tips collected, tip % of revenue, and tip distribution by day.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        total_tips = 0.0
        total_revenue = 0.0
        tips_by_day: dict = defaultdict(float)
        dow_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

        for order in orders:
            for check in order.get("checks", []):
                tip = float(check.get("tipAmount", 0) or 0)
                sub = float(check.get("totalAmount", 0) or 0)
                total_tips += tip
                total_revenue += sub
            opened = order.get("openedDate", "")
            if opened:
                dt = datetime.fromisoformat(opened.replace("Z", "+00:00"))
                for check in order.get("checks", []):
                    tips_by_day[dt.weekday()] += float(check.get("tipAmount", 0) or 0)

        tip_pct = (total_tips / total_revenue * 100) if total_revenue else 0
        lines = [
            f"Toast Tips Summary — {start_date} to {end_date}",
            f"",
            f"Total Tips:      {fmt_currency(total_tips)}",
            f"Total Revenue:   {fmt_currency(total_revenue)}",
            f"Tip Rate:        {fmt_pct(tip_pct)}",
            f"",
            f"Tips by Day of Week:",
        ]
        for dow in range(7):
            tips = tips_by_day.get(dow, 0)
            lines.append(f"  {dow_names[dow]:<12}  {fmt_currency(tips)}")

        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_tips_summary failed: %s", e)
        return f"Error fetching Toast tips summary: {e}"
