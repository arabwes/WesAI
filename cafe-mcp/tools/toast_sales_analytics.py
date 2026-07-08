"""Toast sales analytics — daypart breakdown and exact hourly revenue (dollar values, not symbols).

Complements toast_hourly_heatmap (symbol-based) without replacing it.
"""
import logging
from collections import defaultdict
from datetime import datetime
from mcp_common.errors import safe_error
from clients import toast_client
from config import config, NotConfiguredError
from utils.date_helpers import to_start_end, to_toast_datetime
from utils.formatting import fmt_currency
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_PENDING_MSG = (
    "Toast API access is pending approval.\n"
    "To enable Toast tools:\n"
    "  1. Apply at developers.toasttab.com\n"
    "  2. Once approved, add TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, "
    "and TOAST_RESTAURANT_GUID to your environment variables.\n"
    "  3. Set TOAST_API_PENDING=false\n"
)
_DOW_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_DAYPARTS = [
    ("Morning", 8, 11),
    ("Midday", 11, 14),
    ("Afternoon", 14, 17),
    ("Evening", 17, 21),
    ("Late Night", 21, 27),  # wraps past midnight; hour mod 24 handled below
]


def _check_pending():
    return _PENDING_MSG if config.toast_api_pending else None


def _fetch_orders(start_date: str, end_date: str) -> list:
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


def _daypart_for_hour(hour: int) -> str:
    for name, start_h, end_h in _DAYPARTS:
        if start_h <= hour < end_h:
            return name
    return "Late Night"  # hours 0-2 (post-midnight wraparound)


@api_retry()
async def toast_sales_by_daypart(start_date: str, end_date: str) -> dict:
    """
    Revenue split across dayparts (Morning/Midday/Afternoon/Evening/Late Night) for a date range.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        start, end = to_start_end("custom", start_date, end_date)
        orders = _fetch_orders(start_date, end_date)
        num_days = (end - start).days + 1

        daypart_totals: dict = defaultdict(float)
        by_dow_daypart: dict = defaultdict(lambda: defaultdict(float))
        by_dow_total: dict = defaultdict(float)
        total_revenue = 0.0

        for order in orders:
            opened = order.get("openedDate", "")
            if not opened:
                continue
            try:
                dt = datetime.fromisoformat(opened.replace("Z", "+00:00"))
            except Exception:
                continue
            amount = float(order.get("totalAmount", 0) or 0)
            part = _daypart_for_hour(dt.hour)
            daypart_totals[part] += amount
            by_dow_daypart[_DOW_NAMES[dt.weekday()]][part] += amount
            by_dow_total[_DOW_NAMES[dt.weekday()]] += amount
            total_revenue += amount

        by_daypart = {}
        for name, _, _ in _DAYPARTS:
            rev = daypart_totals.get(name, 0.0)
            by_daypart[name] = {
                "revenue": round(rev, 2),
                "pct_of_total": round((rev / total_revenue * 100) if total_revenue else 0, 1),
                "avg_per_day": round(rev / num_days, 2) if num_days else 0,
            }

        by_day_of_week = {}
        for day, parts in by_dow_daypart.items():
            day_total = by_dow_total.get(day, 0.0)
            by_day_of_week[day] = {
                part: {
                    "revenue": round(rev, 2),
                    "pct_of_day": round((rev / day_total * 100) if day_total else 0, 1),
                }
                for part, rev in parts.items()
            }

        return {
            "period": f"{start_date} to {end_date}",
            "by_daypart": by_daypart,
            "by_day_of_week": by_day_of_week,
        }
    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return {"error": str(e)}
        return {"error": safe_error(e, "fetching Toast sales by daypart")}


@api_retry()
async def toast_hourly_revenue(start_date: str, end_date: str) -> dict:
    """
    Average revenue per hour of day, per day of week — exact dollar values (not symbols).

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        from datetime import timedelta
        start, end = to_start_end("custom", start_date, end_date)
        orders = _fetch_orders(start_date, end_date)

        occurrences = defaultdict(int)
        d = start
        while d <= end:
            occurrences[d.weekday()] += 1
            d += timedelta(days=1)

        revenue: dict = defaultdict(lambda: defaultdict(float))
        for order in orders:
            opened = order.get("openedDate", "")
            if not opened:
                continue
            try:
                dt = datetime.fromisoformat(opened.replace("Z", "+00:00"))
            except Exception:
                continue
            amount = float(order.get("totalAmount", 0) or 0)
            revenue[dt.weekday()][f"{dt.hour:02d}"] += amount

        by_day = {}
        flat = []
        for dow in range(7):
            day_name = _DOW_NAMES[dow]
            occ = occurrences.get(dow, 0) or 1
            hours = {}
            for hour, total in revenue.get(dow, {}).items():
                avg = total / occ
                hours[hour] = {"avg_revenue": round(avg, 2), "data_points": occurrences.get(dow, 0)}
                flat.append({"day": day_name, "hour": hour, "avg_revenue": round(avg, 2)})
            by_day[day_name] = hours

        top_5 = sorted(flat, key=lambda x: -x["avg_revenue"])[:5]
        return {"period": f"{start_date} to {end_date}", "by_day": by_day, "top_5_hours": top_5}
    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return {"error": str(e)}
        return {"error": safe_error(e, "fetching Toast hourly revenue")}
