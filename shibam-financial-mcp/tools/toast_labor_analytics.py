"""Toast hourly sales/labor analytics — 4 tools for hour-by-hour staffing decisions.

All tools average across however many calendar weeks fall in the requested date range,
bucketed by day-of-week x hour-of-day (server local time as returned by Toast).
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from clients import toast_client
from config import config
from utils.date_helpers import to_start_end, to_toast_datetime
from utils.retry import api_retry

from mcp_common.errors import safe_error
from config import NotConfiguredError

logger = logging.getLogger(__name__)

_PENDING_MSG = (
    "Toast API access is pending approval.\n"
    "Set TOAST_API_PENDING=false and add Toast credentials to enable these tools.\n"
    "Apply at: developers.toasttab.com"
)
_DOW_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _check_pending():
    return _PENDING_MSG if config.toast_api_pending else None


def _occurrences_per_dow(start, end) -> dict:
    """Count how many calendar dates in [start, end] fall on each day-of-week (0=Mon)."""
    counts = defaultdict(int)
    d = start
    while d <= end:
        counts[d.weekday()] += 1
        d += timedelta(days=1)
    return counts


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


def _fetch_time_entries(start_date: str, end_date: str) -> list:
    start, end = to_start_end("custom", start_date, end_date)
    entries = toast_client.get("/labor/v1/timeEntries", params={
        "startDate": to_toast_datetime(start),
        "endDate": to_toast_datetime(end, end_of_day=True),
    })
    if isinstance(entries, dict):
        entries = entries.get("timeEntries", [])
    return entries


@api_retry()
async def toast_sales_by_hour(start_date: str, end_date: str) -> dict:
    """
    Returns exact average revenue per hour of day, per day of week, across a date range.

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
        occurrences = _occurrences_per_dow(start, end)

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

        return {
            "period": f"{start_date} to {end_date}",
            "by_day": by_day,
            "top_5_hours": top_5,
        }
    except Exception as e:
        logger.error("toast_sales_by_hour failed: %s", e)
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return {"error": str(e)}
        return {"error": safe_error(e, "fetching Toast sales by hour")}


@api_retry()
async def toast_labor_hourly_headcount(start_date: str, end_date: str) -> dict:
    """
    Returns average number of employees clocked in during each hour of each day of week.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        start, end = to_start_end("custom", start_date, end_date)
        entries = _fetch_time_entries(start_date, end_date)
        occurrences = _occurrences_per_dow(start, end)

        headcount: dict = defaultdict(lambda: defaultdict(int))
        for entry in entries:
            in_dt, out_dt = entry.get("inDate", ""), entry.get("outDate", "")
            if not in_dt or not out_dt:
                continue
            try:
                s = datetime.fromisoformat(in_dt.replace("Z", "+00:00"))
                e = datetime.fromisoformat(out_dt.replace("Z", "+00:00"))
            except Exception:
                continue
            cur = s.replace(minute=0, second=0, microsecond=0)
            while cur < e:
                headcount[cur.weekday()][f"{cur.hour:02d}"] += 1
                cur += timedelta(hours=1)

        by_day = {}
        for dow in range(7):
            day_name = _DOW_NAMES[dow]
            occ = occurrences.get(dow, 0) or 1
            hours = {}
            for hour, count in headcount.get(dow, {}).items():
                hours[hour] = {"avg_headcount": round(count / occ, 2), "data_points": occurrences.get(dow, 0)}
            by_day[day_name] = hours

        return {"period": f"{start_date} to {end_date}", "by_day": by_day}
    except Exception as e:
        logger.error("toast_labor_hourly_headcount failed: %s", e)
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return {"error": str(e)}
        return {"error": safe_error(e, "fetching Toast labor hourly headcount")}


@api_retry()
async def toast_labor_detail_by_day(start_date: str, end_date: str) -> dict:
    """
    Returns per-employee clock-in/clock-out detail grouped by day of week.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        entries = _fetch_time_entries(start_date, end_date)

        employees = {}
        try:
            emp_data = toast_client.get("/labor/v1/employees")
            emp_list = emp_data if isinstance(emp_data, list) else emp_data.get("employees", [])
            for e in emp_list:
                employees[e.get("guid", "")] = e
        except Exception as e:
            logger.warning("Could not fetch employee detail: %s", e)

        by_day: dict = defaultdict(list)
        day_totals: dict = defaultdict(lambda: {"hours": 0.0, "cost": 0.0, "headcount": set()})

        for entry in entries:
            in_dt, out_dt = entry.get("inDate", ""), entry.get("outDate", "")
            if not in_dt or not out_dt:
                continue
            try:
                s = datetime.fromisoformat(in_dt.replace("Z", "+00:00"))
                e_time = datetime.fromisoformat(out_dt.replace("Z", "+00:00"))
            except Exception:
                continue
            hours = (e_time - s).total_seconds() / 3600
            wage = float(entry.get("hourlyWage", 0) or 0)
            cost = hours * wage
            emp_guid = entry.get("employeeReference", {}).get("guid", "") if isinstance(entry.get("employeeReference"), dict) else ""
            emp = employees.get(emp_guid, {})
            name = f"{emp.get('firstName', '')} {emp.get('lastName', '')}".strip() or "Unknown"
            job = entry.get("jobReference", {}).get("title", "") if isinstance(entry.get("jobReference"), dict) else "Unknown"

            day_name = _DOW_NAMES[s.weekday()]
            by_day[day_name].append({
                "employee": name,
                "job": job,
                "clock_in": s.isoformat(),
                "clock_out": e_time.isoformat(),
                "hours": round(hours, 2),
                "hourly_rate": wage,
                "shift_cost": round(cost, 2),
            })
            day_totals[day_name]["hours"] += hours
            day_totals[day_name]["cost"] += cost
            day_totals[day_name]["headcount"].add(emp_guid or name)

        summary = {
            day: {
                "total_hours": round(v["hours"], 1),
                "total_cost": round(v["cost"], 2),
                "avg_headcount": len(v["headcount"]),
            }
            for day, v in day_totals.items()
        }

        return {
            "period": f"{start_date} to {end_date}",
            "by_day": dict(by_day),
            "summary_by_day": summary,
        }
    except Exception as e:
        logger.error("toast_labor_detail_by_day failed: %s", e)
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return {"error": str(e)}
        return {"error": safe_error(e, "fetching Toast labor detail by day")}


@api_retry()
async def toast_labor_cost_by_hour(start_date: str, end_date: str) -> dict:
    """
    Returns average labor cost per hour of day, per day of week, across a date range.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        start, end = to_start_end("custom", start_date, end_date)
        entries = _fetch_time_entries(start_date, end_date)
        occurrences = _occurrences_per_dow(start, end)

        cost_buckets: dict = defaultdict(lambda: defaultdict(float))
        headcount_buckets: dict = defaultdict(lambda: defaultdict(int))
        for entry in entries:
            in_dt, out_dt = entry.get("inDate", ""), entry.get("outDate", "")
            if not in_dt or not out_dt:
                continue
            try:
                s = datetime.fromisoformat(in_dt.replace("Z", "+00:00"))
                e = datetime.fromisoformat(out_dt.replace("Z", "+00:00"))
            except Exception:
                continue
            wage = float(entry.get("hourlyWage", 0) or 0)
            cur = s.replace(minute=0, second=0, microsecond=0)
            while cur < e:
                seg_end = min(e, cur + timedelta(hours=1))
                frac = (seg_end - cur).total_seconds() / 3600
                cost_buckets[cur.weekday()][f"{cur.hour:02d}"] += wage * frac
                headcount_buckets[cur.weekday()][f"{cur.hour:02d}"] += 1
                cur += timedelta(hours=1)

        by_day = {}
        for dow in range(7):
            day_name = _DOW_NAMES[dow]
            occ = occurrences.get(dow, 0) or 1
            hours = {}
            for hour, total in cost_buckets.get(dow, {}).items():
                hours[hour] = {
                    "avg_labor_cost": round(total / occ, 2),
                    "avg_headcount": round(headcount_buckets[dow][hour] / occ, 2),
                }
            by_day[day_name] = hours

        return {"period": f"{start_date} to {end_date}", "by_day": by_day}
    except Exception as e:
        logger.error("toast_labor_cost_by_hour failed: %s", e)
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return {"error": str(e)}
        return {"error": safe_error(e, "fetching Toast labor cost by hour")}
