"""WhenIWork scheduling MCP tools — 3 tools covering schedules, labor forecast, and projected cost."""
import logging
from datetime import datetime
from collections import defaultdict
from clients import wheniwork_client
from utils.date_helpers import to_start_end
from utils.formatting import fmt_currency, fmt_number, fmt_pct, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)


def _check_wiw() -> str | None:
    from config import config
    if not config.wheniwork_ready:
        return "WhenIWork not configured. Add WHENIWORK_API_KEY and WHENIWORK_ACCOUNT_ID to your Railway environment variables."
    return None


@api_retry()
async def whenIwork_schedule(
    start_date: str,
    end_date: str,
) -> str:
    """
    Fetch all scheduled shifts from WhenIWork for a date range.

    Returns shifts grouped by day, showing role and scheduled hours.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    err = _check_wiw()
    if err: return err
    try:
        shifts = wheniwork_client.get_shifts(start_date, end_date)
        users = wheniwork_client.get_users()
        positions = wheniwork_client.get_positions()

        if not shifts:
            return f"No shifts scheduled in WhenIWork for {start_date} to {end_date}."

        # Group shifts by date
        by_date: dict = defaultdict(list)
        for shift in shifts:
            start_ts = shift.get("start_time", "")
            end_ts = shift.get("end_time", "")
            if not start_ts:
                continue
            try:
                s = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
                e = datetime.fromisoformat(end_ts.replace("Z", "+00:00")) if end_ts else s
                hours = (e - s).total_seconds() / 3600
                user_id = str(shift.get("user_id", ""))
                position_id = str(shift.get("position_id", ""))
                user = users.get(user_id, {})
                first_name = user.get("first_name", "")
                role = positions.get(position_id, "Staff")
                day_key = s.strftime("%A %m/%d")
                by_date[day_key].append({
                    "Time": f"{s.strftime('%I:%M %p')}–{e.strftime('%I:%M %p')}",
                    "Role": role,
                    "Name": first_name or "—",
                    "Hours": fmt_number(hours, 1),
                })
            except Exception:
                continue

        total_shifts = sum(len(v) for v in by_date.values())
        total_hours = sum(
            sum(float(s["Hours"]) for s in shifts_list)
            for shifts_list in by_date.values()
        )

        lines = [
            f"WhenIWork Schedule — {start_date} to {end_date}",
            f"Total: {total_shifts} shifts / {fmt_number(total_hours, 1)} hours",
            f"",
        ]
        for day in sorted(by_date.keys()):
            day_shifts = by_date[day]
            day_hrs = sum(float(s["Hours"]) for s in day_shifts)
            lines.append(f"── {day}  ({fmt_number(day_hrs, 1)} hrs total) ──")
            lines.append(fmt_table(day_shifts, ["Time", "Role", "Name", "Hours"]))
            lines.append("")

        return "\n".join(lines)

    except Exception as e:
        logger.error("whenIwork_schedule failed: %s", e)
        return f"Error fetching WhenIWork schedule: {e}"


@api_retry()
async def whenIwork_labor_forecast(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Compare WhenIWork scheduled hours vs Toast actual clock-in hours, day by day.

    Flags days where actual hours significantly exceeded or missed scheduled hours.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    err = _check_wiw()
    if err: return err
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        shifts = wheniwork_client.get_shifts(str(start), str(end))

        scheduled_by_day: dict = defaultdict(float)
        for shift in shifts:
            start_ts = shift.get("start_time", "")
            end_ts = shift.get("end_time", "")
            if not start_ts or not end_ts:
                continue
            try:
                s = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
                e = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
                hours = (e - s).total_seconds() / 3600
                scheduled_by_day[s.strftime("%Y-%m-%d")] += hours
            except Exception:
                continue

        # Get Toast actual hours if available
        actual_by_day: dict = defaultdict(float)
        toast_available = False
        if not __import__("config").config.toast_api_pending:
            try:
                from clients import toast_client
                from utils.date_helpers import to_toast_datetime
                time_entries = toast_client.get("/labor/v1/timeEntries", params={
                    "startDate": to_toast_datetime(start),
                    "endDate": to_toast_datetime(end, end_of_day=True),
                })
                if isinstance(time_entries, dict):
                    time_entries = time_entries.get("timeEntries", [])
                for entry in time_entries:
                    in_dt = entry.get("inDate", "")
                    out_dt = entry.get("outDate", "")
                    if in_dt and out_dt:
                        s_time = datetime.fromisoformat(in_dt.replace("Z", "+00:00"))
                        e_time = datetime.fromisoformat(out_dt.replace("Z", "+00:00"))
                        hours = (e_time - s_time).total_seconds() / 3600
                        actual_by_day[s_time.strftime("%Y-%m-%d")] += hours
                toast_available = True
            except Exception:
                pass

        all_days = sorted(set(list(scheduled_by_day.keys()) + list(actual_by_day.keys())))
        rows = []
        for day in all_days:
            sched = scheduled_by_day.get(day, 0)
            actual = actual_by_day.get(day, 0) if toast_available else None
            diff = (actual - sched) if actual is not None else None
            flag = ""
            if diff is not None:
                if diff > 2:
                    flag = "⚠️ Over by " + fmt_number(diff, 1) + " hrs"
                elif diff < -2:
                    flag = "⚠️ Under by " + fmt_number(abs(diff), 1) + " hrs"
                else:
                    flag = "✅ On track"
            rows.append({
                "Date": day,
                "Scheduled": fmt_number(sched, 1) + " hrs",
                "Actual": fmt_number(actual, 1) + " hrs" if actual is not None else "—",
                "Variance": (("+" if diff >= 0 else "") + fmt_number(diff, 1) + " hrs") if diff is not None else "—",
                "Status": flag,
            })

        cols = ["Date", "Scheduled", "Actual", "Variance", "Status"]
        note = "" if toast_available else "\n\nNote: Toast actual hours unavailable (TOAST_API_PENDING=true). Showing scheduled hours only."
        return (
            f"WhenIWork Labor Forecast vs Actual — {date_range} ({start} to {end})\n\n"
            + fmt_table(rows, cols)
            + note
        )

    except Exception as e:
        logger.error("whenIwork_labor_forecast failed: %s", e)
        return f"Error fetching WhenIWork labor forecast: {e}"


@api_retry()
async def whenIwork_schedule_cost(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Estimate projected labor cost from WhenIWork scheduled hours × hourly rate by role.

    Useful for projecting payroll cost before a pay period closes.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    err = _check_wiw()
    if err: return err
    try:
        start, end = to_start_end(date_range, start_date, end_date)
        shifts = wheniwork_client.get_shifts(str(start), str(end))
        users = wheniwork_client.get_users()
        positions = wheniwork_client.get_positions()

        if not shifts:
            return f"No scheduled shifts found in WhenIWork for {date_range}."

        role_hours: dict = defaultdict(float)
        for shift in shifts:
            start_ts = shift.get("start_time", "")
            end_ts = shift.get("end_time", "")
            if not start_ts or not end_ts:
                continue
            try:
                s = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
                e = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
                hours = (e - s).total_seconds() / 3600
                position_id = str(shift.get("position_id", ""))
                role = positions.get(position_id, "Staff")
                role_hours[role] += hours
            except Exception:
                continue

        # WhenIWork API v2 does not expose hourly rates on shifts directly.
        # We note this limitation and show hours only, with a formula explanation.
        total_hours = sum(role_hours.values())

        rows = [{"Role": role, "Scheduled Hours": fmt_number(hrs, 1)} for role, hrs in sorted(role_hours.items(), key=lambda x: -x[1])]
        cols = ["Role", "Scheduled Hours"]

        lines = [
            f"WhenIWork Scheduled Hours by Role — {date_range} ({start} to {end})",
            f"Total: {fmt_number(total_hours, 1)} hours",
            f"",
            fmt_table(rows, cols),
            f"",
            f"To project cost: multiply each role's hours by their hourly wage rate.",
            f"Wage rates are managed in WhenIWork → Team → each employee's profile.",
            f"",
            f"For actual incurred cost, use: payroll_labor_percentage or toast_labor_summary",
        ]

        return "\n".join(lines)

    except Exception as e:
        logger.error("whenIwork_schedule_cost failed: %s", e)
        return f"Error fetching WhenIWork schedule cost: {e}"
