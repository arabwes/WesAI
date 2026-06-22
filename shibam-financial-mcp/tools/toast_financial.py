"""Toast POS financial extension MCP tools — 6 tools for modifiers, labor, voids, tips, and tip calculator.
These complement the sales tools in shibam-marketing-mcp without duplicating them.
All tools respect the TOAST_API_PENDING flag.
"""
import logging
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Optional
from clients import toast_client
from config import config
from utils.date_helpers import to_start_end, to_toast_datetime
from utils.kpi_status import labor_pct_status
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

# Toast timestamps are UTC epoch milliseconds; convert to this timezone for
# hourly tip/labor binning so results match the PaymentDetails CSV (local time).
_RESTAURANT_TZ = ZoneInfo("America/New_York")


def _epoch_to_local(ms: int) -> datetime:
    """Convert a Toast UTC millisecond epoch to a naive local datetime."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(_RESTAURANT_TZ).replace(tzinfo=None)


def _iso_to_local(iso: str) -> datetime:
    """Convert a Toast ISO UTC string (e.g. '2026-06-14T22:00:00.000+0000') to naive local datetime."""
    return datetime.fromisoformat(iso.replace("+0000", "+00:00").replace("Z", "+00:00")).astimezone(_RESTAURANT_TZ).replace(tzinfo=None)


def _to_local_dt(value) -> datetime:
    """Parse a Toast timestamp (epoch int OR ISO string) into a naive local datetime."""
    if isinstance(value, (int, float)):
        return _epoch_to_local(int(value))
    return _iso_to_local(str(value))


_PENDING_MSG = (
    "Toast API access is pending approval.\n"
    "Set TOAST_API_PENDING=false and add Toast credentials to enable these tools.\n"
    "Apply at: developers.toasttab.com"
)

# Cache order fetches — multiple tools called with the same date range re-use the
# result. Live ranges (including today) use a short TTL since orders are still
# accumulating; fully-closed past ranges never change, so they cache far longer.
_orders_cache: dict = {}
_CACHE_TTL = 300            # ranges that include today
_CLOSED_RANGE_TTL = 86400  # ranges entirely in the past (orders are final)
_orders_fetch_lock = threading.Lock()

# Payment statuses that represent money actually collected. Toast's own Payments
# summary counts CAPTURED + AUTHORIZED (auth'd cards settle later but are real
# revenue); DENIED and VOIDED are excluded. (None = legacy/unset, kept defensively.)
_COLLECTED_PAYMENT_STATUSES = (None, "CAPTURED", "AUTHORIZED")

# Employee GUID → full name map, fetched once per process lifetime.
_employee_map: dict = {}
_employee_map_loaded: bool = False

# Config GUID → name maps (sales categories, dining options, void reasons).
# Order payloads carry these as GUID-only references, so we resolve names from
# the /config/v2 endpoints once and cache for the process lifetime.
_config_maps: dict = {}        # endpoint path → {guid: name}


def _check_pending() -> Optional[str]:
    return _PENDING_MSG if config.toast_api_pending else None


def _get_employee_map() -> dict:
    """Return {employee_guid: full_name}. Fetched once and cached for the process lifetime."""
    global _employee_map, _employee_map_loaded
    if _employee_map_loaded:
        return _employee_map
    try:
        employees = toast_client.get("/labor/v1/employees")
        if isinstance(employees, list):
            for emp in employees:
                guid = emp.get("guid", "")
                name = f"{emp.get('firstName', '')} {emp.get('lastName', '')}".strip()
                if guid and name:
                    _employee_map[guid] = name
        _employee_map_loaded = True
        logger.info("Loaded %d employees from Toast", len(_employee_map))
    except Exception as e:
        logger.warning("Could not load employee map: %s", e)
    return _employee_map


def _employee_name(entry: dict) -> str:
    """Resolve an employee name from a time entry's employeeReference."""
    ref = entry.get("employeeReference", {})
    guid = ref.get("guid", "") if isinstance(ref, dict) else ""
    if guid:
        emp_map = _get_employee_map()
        if guid in emp_map:
            return emp_map[guid]
    return f"Employee-{guid[:8]}" if guid else "Unknown"


def _config_map(path: str, name_field: str = "name") -> dict:
    """Return {guid: name} for a /config/v2 collection, cached for the process lifetime.
    Falls back to an empty map (callers degrade to GUIDs) if the endpoint is unavailable."""
    if path in _config_maps:
        return _config_maps[path]
    mapping: dict = {}
    try:
        items = toast_client.get(path)
        if isinstance(items, list):
            for it in items:
                guid = it.get("guid", "")
                name = it.get(name_field) or it.get("name") or ""
                if guid and name:
                    mapping[guid] = name
        logger.info("Loaded %d entries from %s", len(mapping), path)
    except Exception as e:
        logger.warning("Could not load config map %s: %s", path, e)
    _config_maps[path] = mapping
    return mapping


def _category_name(selection: dict) -> str:
    """Resolve a selection's sales-category name (order payloads carry only the GUID)."""
    sc = selection.get("salesCategory") or {}
    if not isinstance(sc, dict):
        return "Uncategorized"
    name = sc.get("name")
    if name:
        return name
    guid = sc.get("guid", "")
    return _config_map("/config/v2/salesCategories").get(guid, "Uncategorized")


def _dining_option_name(order: dict) -> str:
    """Resolve an order's dining-option name (e.g. 'Dine In', 'DoorDash - Delivery')."""
    do = order.get("diningOption") or {}
    if not isinstance(do, dict):
        return "Unknown"
    guid = do.get("guid", "")
    return _config_map("/config/v2/diningOptions").get(guid, "Unknown")


def _void_reason_name(vr_ref: dict) -> str:
    """Resolve a void-reason name from a selection's voidReason reference ({guid}).
    Toast marks voided line items with selection.voided=True and a voidReason GUID
    reference (no inline name), so we resolve the name from /config/v2/voidReasons."""
    if not isinstance(vr_ref, dict):
        return "Unknown"
    name = vr_ref.get("englishName") or vr_ref.get("name")
    if name:
        return name
    guid = vr_ref.get("guid", "")
    if guid:
        resolved = _config_map("/config/v2/voidReasons", name_field="name").get(guid)
        if resolved:
            return resolved
    return "Unknown"


def _fetch_orders(start_date: str, end_date: str) -> list:
    """Fetch full order objects for a date range, cached in-process.

    Serialized by a process-wide lock so two overlapping calls never run duplicate
    concurrent fetches — a second caller waits and reuses the first's cached result.
    Closed (past) ranges cache for 24h since their orders are final; ranges that
    include today use a short TTL since orders are still accumulating.
    """
    cache_key = (start_date, end_date)
    with _orders_fetch_lock:
        now = time.time()
        today_local = datetime.now(_RESTAURANT_TZ).date()
        try:
            range_closed = to_start_end("custom", start_date, end_date)[1] < today_local
        except Exception:
            range_closed = False
        ttl = _CLOSED_RANGE_TTL if range_closed else _CACHE_TTL

        if cache_key in _orders_cache:
            cached, ts = _orders_cache[cache_key]
            if now - ts < ttl:
                logger.debug("_fetch_orders cache hit: %s to %s", start_date, end_date)
                return cached

        result = _do_fetch_orders(start_date, end_date)
        _orders_cache[cache_key] = (result, time.time())
        return result


def _do_fetch_orders(start_date: str, end_date: str) -> list:
    """Fetch full orders via /orders/v2/ordersBulk, one paginated query per local
    business day. This returns complete order objects directly (checks, selections,
    payments) — no separate GUID-listing pass and no per-order detail calls — cutting
    a week-long fetch from ~1,300 requests to ~20 and removing the rate-limit pressure
    that previously caused silent undercounts.

    We scan businessDates [start-1, end+1] (a ±1-day buffer, since an order opened just
    after midnight can be assigned to the adjacent businessDate) and then keep only
    orders whose LOCAL openedDate falls in [start, end]. That preserves the exact
    calendar-day semantics the tools already rely on — including the tip calculator,
    which is validated against the PaymentDetails CSV's openedDate-based "Order Date".
    """
    start, end = to_start_end("custom", start_date, end_date)
    fetch_t0 = time.time()
    by_guid: dict = {}
    pages = 0
    day = start - timedelta(days=1)
    last_day = end + timedelta(days=1)
    while day <= last_day:
        bd = day.strftime("%Y%m%d")
        page = 1
        while True:
            chunk = toast_client.get("/orders/v2/ordersBulk", params={
                "businessDate": bd, "pageSize": 100, "page": page,
            })
            if not isinstance(chunk, list) or not chunk:
                break
            for o in chunk:
                guid = o.get("guid")
                if guid:
                    by_guid[guid] = o
            pages += 1
            if len(chunk) < 100:
                break
            page += 1
        day += timedelta(days=1)

    # Keep only orders whose local openedDate is within the requested calendar range.
    result = []
    for o in by_guid.values():
        opened = o.get("openedDate")
        if not opened:
            continue
        try:
            d = _to_local_dt(opened).date()
        except Exception:
            continue
        if start <= d <= end:
            result.append(o)

    logger.info(
        "_do_fetch_orders %s..%s: %d bulk pages across business days, "
        "%d orders fetched, %d in window (%.1fs)",
        start_date, end_date, pages, len(by_guid), len(result), time.time() - fetch_t0,
    )
    return result


def _order_total(order: dict) -> float:
    """DEPRECATED for revenue: check.totalAmount = sales + tax + tips (total collected),
    NOT 'sales'. Kept only where the gross collected figure is genuinely wanted.
    For sales/labor%/tip-rate/channel revenue use _order_sales (net of tax & tips)."""
    return sum(float(c.get("totalAmount", 0) or 0) for c in order.get("checks", []))


# ── Revenue components (verified against Toast Sales Summary, week of 2026-06-15) ──
# check.amount = sales after discounts, excl. tax & tips  → Toast "Net sales"
# check.taxAmount = tax ; payment.tipAmount = tips ; payment.originalProcessingFee = card fee
def _order_sales(order: dict) -> float:
    """Gross Sales after discounts (the 'sales only' figure; excludes tax & tips)."""
    return sum(float(c.get("amount", 0) or 0) for c in order.get("checks", []))


def _order_tax(order: dict) -> float:
    return sum(float(c.get("taxAmount", 0) or 0) for c in order.get("checks", []))


def _order_tips(order: dict) -> float:
    return sum(
        float(p.get("tipAmount", 0) or 0)
        for c in order.get("checks", [])
        for p in (c.get("payments") or [])
    )


def _order_processing_fees(order: dict) -> float:
    return sum(
        float(p.get("originalProcessingFee", 0) or 0)
        for c in order.get("checks", [])
        for p in (c.get("payments") or [])
    )


def _order_discounts(order: dict) -> float:
    """Approximate total applied discount across checks (check-level appliedDiscounts).
    NOTE: Toast's discount accounting is layered (check- vs selection-level can overlap);
    this under/over-counts the exact figure, so the breakdown labels the discount and
    gross-before-discount lines as approximate. The authoritative 'sales' number is
    check.amount (_order_sales), which is already net of discounts and is exact."""
    total = 0.0
    for c in order.get("checks", []):
        for d in (c.get("appliedDiscounts") or []):
            total += float(d.get("discountAmount", d.get("amount", 0)) or 0)
    return total


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

        # Get revenue for the same period to calculate labor %. Use net Sales
        # (check.amount), not totalAmount, so labor % matches Toast's dashboard.
        orders = _fetch_orders(start_date, end_date)
        total_revenue = sum(_order_sales(o) for o in orders)

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
                job = entry.get("jobReference", entry.get("jobCode"))
                role = job.get("title", "") if isinstance(job, dict) else ""
                if not role:
                    role = _employee_name(entry)
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
            amount = _order_sales(order)  # net Sales basis (matches dashboard)
            opened = order.get("openedDate", "")
            if opened:
                dt = _to_local_dt(opened)
                revenue_by_dow[dt.weekday()] += amount
                order_days[dt.weekday()] += 1

        for entry in time_entries:
            in_dt = entry.get("inDate", "")
            out_dt = entry.get("outDate", "")
            if not in_dt or not out_dt:
                continue
            try:
                in_time = _to_local_dt(in_dt)
                out_time = _to_local_dt(out_dt)
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
                    if selection.get("voided"):
                        reason = _void_reason_name(selection.get("voidReason"))
                        item_price = float(selection.get("preDiscountPrice", 0) or 0)
                        voids.append({
                            "Date": order.get("openedDate", "")[:10],
                            "Item": selection.get("displayName", "")[:30],
                            "Amount": fmt_currency(item_price),
                            "Reason": reason[:40],
                            "Type": "Void",
                        })

        total_void_value = sum(
            float(s.get("preDiscountPrice", 0) or 0)
            for o in orders
            for c in o.get("checks", [])
            for s in c.get("selections", [])
            if s.get("voided")
        )
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
                tip = sum(float(p.get("tipAmount", 0) or 0) for p in check.get("payments", []) or [])
                sub = float(check.get("amount", 0) or 0)  # net Sales basis → tip rate matches dashboard
                total_tips += tip
                total_revenue += sub
            opened = order.get("openedDate", "")
            if opened:
                dt = _to_local_dt(opened)
                for check in order.get("checks", []):
                    tip = sum(float(p.get("tipAmount", 0) or 0) for p in check.get("payments", []) or [])
                    tips_by_day[dt.weekday()] += tip

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


@api_retry()
async def toast_tip_calculator(start_date: str, end_date: str) -> str:
    """
    Calculate per-employee tip allocation for a pay period.

    Automates the manual tip distribution workflow:
      1. Fetches employee shifts from Toast labor (replaces TimeEntries CSV download)
      2. Fetches hourly tip totals from Toast orders (replaces PaymentDetails CSV download)
      3. Distributes tips proportionally by minutes worked in each hour
      4. Applies 3% processing fee deduction
      5. Rounds hours to nearest 0.5

    Returns a payroll-ready table to enter in QuickBooks under "paycheck tips".
    Replaces the manual Jupyter notebook workflow.

    Args:
        start_date: YYYY-MM-DD (start of pay period — typically bi-weekly)
        end_date:   YYYY-MM-DD (end of pay period)
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        start, end = to_start_end("custom", start_date, end_date)
        end_plus1 = str(end + timedelta(days=1))  # extend 1 day to capture late-evening local orders

        # Fetch time entries and orders.
        # Orders are fetched with a 1-day buffer on the end so late-evening local-time
        # orders (whose UTC epoch falls on the next calendar day) are included.
        time_entries = toast_client.get("/labor/v1/timeEntries", params={
            "startDate": to_toast_datetime(start),
            "endDate": to_toast_datetime(end + timedelta(days=1), end_of_day=True),
        })
        if isinstance(time_entries, dict):
            time_entries = time_entries.get("timeEntries", [])
        orders = _fetch_orders(start_date, end_plus1)

        # Build hourly tip totals from payment-level tipAmount (check.tipAmount is always None).
        # Convert UTC epoch to local time so hourly buckets match the PaymentDetails CSV.
        tips_by_hour: dict = defaultdict(float)
        for order in orders:
            opened = order.get("openedDate")
            if not opened:
                continue
            try:
                dt_local = _to_local_dt(opened)
                # Filter to requested local date range (the +1-day buffer may include extra)
                if not (start <= dt_local.date() <= end):
                    continue
                key = (dt_local.date(), dt_local.hour)
                for check in order.get("checks", []):
                    for pmt in check.get("payments", []) or []:
                        tips_by_hour[key] += float(pmt.get("tipAmount", 0) or 0)
                    for gsc in check.get("gratuityServiceCharges", []) or []:
                        tips_by_hour[key] += float(gsc.get("chargeAmount", 0) or 0)
            except Exception:
                continue

        # Build hourly employee-minute buckets from time entries.
        # Convert UTC epoch/ISO to local time so shift hours align with the tip buckets.
        # Track payable hours separately from Toast's regularHours + overtimeHours
        # (which already excludes unpaid breaks) so the hours column matches the
        # TimeEntries "Payable Hours" export rather than raw clock-in→clock-out.
        range_start = datetime(start.year, start.month, start.day, 0, 0, 0)
        range_end   = datetime(end.year,   end.month,   end.day,   23, 59, 59)
        start_bd = int(start.strftime("%Y%m%d"))
        end_bd   = int(end.strftime("%Y%m%d"))

        hour_data: dict = {}
        payable_hours_by_emp: dict = defaultdict(float)
        for entry in time_entries:
            in_val = entry.get("inDate")
            out_val = entry.get("outDate")
            if not in_val or not out_val:
                continue
            name = _employee_name(entry)
            try:
                clock_in  = _to_local_dt(in_val)
                clock_out = _to_local_dt(out_val)
            except Exception:
                continue

            # Payable hours: sum Toast's regular + overtime hours for entries whose
            # business date falls in the pay period (mirrors the CSV export boundary).
            try:
                bd = int(entry.get("businessDate") or 0)
            except (TypeError, ValueError):
                bd = 0
            if start_bd <= bd <= end_bd:
                reg = float(entry.get("regularHours", 0) or 0)
                ot  = float(entry.get("overtimeHours", 0) or 0)
                payable_hours_by_emp[name] += reg + ot

            # Tip distribution: count minutes present, clipped to the local date range
            clock_in  = max(clock_in,  range_start)
            clock_out = min(clock_out, range_end)
            if clock_out <= clock_in:
                continue

            cur = clock_in.replace(minute=0, second=0, microsecond=0)
            while cur < clock_out:
                nxt = cur + timedelta(hours=1)
                mins = (min(clock_out, nxt) - max(clock_in, cur)).total_seconds() / 60
                key = (cur.date(), cur.hour)
                if key not in hour_data:
                    hour_data[key] = {"employees": {}, "total_mins": 0.0}
                hour_data[key]["employees"][name] = hour_data[key]["employees"].get(name, 0) + mins
                hour_data[key]["total_mins"] += mins
                cur = nxt

        # Distribute tips proportionally by minutes worked each hour
        emp_summary: dict = {}
        for key, block in hour_data.items():
            total_tips = tips_by_hour.get(key, 0.0)
            total_mins = block["total_mins"]
            for emp, mins in block["employees"].items():
                share = (total_tips * mins / total_mins) if total_mins > 0 else 0
                rec = emp_summary.setdefault(emp, {"tips": 0.0, "mins": 0.0})
                rec["tips"] += share
                rec["mins"] += mins

        if not emp_summary:
            return f"No employee time entries found for {start_date} to {end_date}."

        grand_gross = sum(v["tips"] for v in emp_summary.values())

        rows = []
        for emp, rec in sorted(emp_summary.items()):
            # Payable hours from Toast regular+overtime (breaks excluded); fall back to
            # minutes-present if the entry had no businessDate/regularHours.
            payable = payable_hours_by_emp.get(emp, rec["mins"] / 60)
            rounded_hours = round(payable * 2) / 2  # nearest 0.5
            net_tips = rec["tips"] * 0.97           # 3% processing fee
            rows.append({
                "Employee": emp,
                "Payable Hours": f"{rounded_hours:.1f}",
                "Gross Tips": fmt_currency(rec["tips"]),
                "Tips (after 3%)": fmt_currency(net_tips),
            })

        return "\n".join([
            f"Toast Tip Calculator — {start_date} to {end_date}",
            f"",
            f"Total gross tips:     {fmt_currency(grand_gross)}",
            f"Total after 3% fee:   {fmt_currency(grand_gross * 0.97)}",
            f"",
            fmt_table(rows, ["Employee", "Payable Hours", "Gross Tips", "Tips (after 3%)"]),
            f"",
            f"Enter 'Tips (after 3%)' per employee in QuickBooks → Payroll → paycheck tips.",
        ])

    except Exception as e:
        logger.error("toast_tip_calculator failed: %s", e)
        return f"Error calculating tips: {e}"


@api_retry()
async def toast_break_compliance(
    start_date: str,
    end_date: str,
    paid_target_min: float = 15.0,
    unpaid_target_min: float = 30.0,
    grace_min: float = 5.0,
) -> str:
    """
    Audit employee break usage against policy.

    Policy targets: paid breaks should be 15 minutes, unpaid breaks 30 minutes.
    Flags breaks that run over the target (beyond a grace window) so you can spot
    employees consistently taking longer breaks than allowed.

    Args:
        start_date:        YYYY-MM-DD
        end_date:          YYYY-MM-DD
        paid_target_min:   Target length for a paid break (default 15).
        unpaid_target_min: Target length for an unpaid break (default 30).
        grace_min:         Minutes over target allowed before a break is flagged (default 5).
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        start, end = to_start_end("custom", start_date, end_date)
        time_entries = toast_client.get("/labor/v1/timeEntries", params={
            "startDate": to_toast_datetime(start),
            "endDate": to_toast_datetime(end, end_of_day=True),
        })
        if isinstance(time_entries, dict):
            time_entries = time_entries.get("timeEntries", [])

        total_breaks = 0
        violations = []                       # rows for breaks over target + grace
        missed_or_waived = []                 # breaks marked missed/waived
        # Per-employee tally: breaks taken, # over target, total overage minutes
        emp_stats: dict = defaultdict(lambda: {"breaks": 0, "over": 0, "overage_min": 0.0})

        for entry in time_entries:
            name = _employee_name(entry)
            for b in (entry.get("breaks") or []):
                total_breaks += 1
                emp_stats[name]["breaks"] += 1

                paid = bool(b.get("paid"))
                target = paid_target_min if paid else unpaid_target_min
                kind = "Paid" if paid else "Unpaid"

                if b.get("missed") or b.get("waived"):
                    flag = "Missed" if b.get("missed") else "Waived"
                    missed_or_waived.append({
                        "Employee": name,
                        "Type": kind,
                        "Status": flag,
                    })
                    continue

                bin_, bout = b.get("inDate"), b.get("outDate")
                if not bin_ or not bout:
                    continue
                try:
                    b_start = _to_local_dt(bin_)
                    dur = (_to_local_dt(bout) - b_start).total_seconds() / 60
                except Exception:
                    continue

                overage = dur - target
                if overage > grace_min:
                    emp_stats[name]["over"] += 1
                    emp_stats[name]["overage_min"] += overage
                    violations.append({
                        "Employee": name,
                        "Date": b_start.strftime("%m/%d %I:%M %p"),
                        "Type": kind,
                        "Target": f"{target:.0f} min",
                        "Actual": f"{dur:.1f} min",
                        "Over By": f"+{overage:.1f} min",
                    })

        if total_breaks == 0:
            return f"No breaks recorded in Toast for {start_date} to {end_date}."

        # Sort violations worst-first
        violations.sort(key=lambda r: float(r["Over By"].split()[0]), reverse=True)

        # Per-employee summary, worst overage first
        emp_rows = []
        for name, st in sorted(emp_stats.items(), key=lambda kv: -kv[1]["overage_min"]):
            if st["breaks"] == 0:
                continue
            emp_rows.append({
                "Employee": name,
                "Breaks": str(st["breaks"]),
                "Over Target": str(st["over"]),
                "Total Overage": f"{st['overage_min']:.0f} min" if st["overage_min"] else "—",
            })

        lines = [
            f"Toast Break Compliance — {start_date} to {end_date}",
            f"Policy: paid breaks {paid_target_min:.0f} min, unpaid {unpaid_target_min:.0f} min "
            f"(grace {grace_min:.0f} min)",
            f"",
            f"Total breaks: {total_breaks}   Over target: {len(violations)}   "
            f"Missed/Waived: {len(missed_or_waived)}",
            f"",
            f"Per-Employee Summary:",
            fmt_table(emp_rows, ["Employee", "Breaks", "Over Target", "Total Overage"]),
        ]

        if violations:
            lines += [
                f"",
                f"Breaks Over Target ({len(violations)}):",
                fmt_table(violations, ["Employee", "Date", "Type", "Target", "Actual", "Over By"]),
            ]
        else:
            lines += ["", "No breaks ran over target beyond the grace window. ✅"]

        if missed_or_waived:
            lines += [
                f"",
                f"Missed/Waived Breaks ({len(missed_or_waived)}):",
                fmt_table(missed_or_waived, ["Employee", "Type", "Status"]),
            ]

        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_break_compliance failed: %s", e)
        return f"Error checking break compliance: {e}"


@api_retry()
async def toast_item_sales_detail(start_date: str, end_date: str, top_n: int = 100) -> str:
    """
    List every menu item sold over a period with quantity, revenue, and category —
    for spotting sales trends across a week or month.

    Aggregates by item (voided items and nested modifiers excluded). Pair with
    `toast_modifier_revenue` for the add-on/modifier dimension.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        top_n:      Max items to list (default 100, sorted by revenue).
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        items: dict = defaultdict(lambda: {"qty": 0, "revenue": 0.0, "orders": set(), "category": ""})

        for order in orders:
            oguid = order.get("guid", "")
            for check in order.get("checks", []):
                for sel in check.get("selections", []):
                    if sel.get("voidInfo"):
                        continue
                    name = sel.get("displayName", "Unknown")
                    qty = int(sel.get("quantity", 1) or 1)
                    price = float(sel.get("preDiscountPrice", 0) or 0) * qty
                    rec = items[name]
                    rec["qty"] += qty
                    rec["revenue"] += price
                    rec["orders"].add(oguid)
                    if not rec["category"]:
                        rec["category"] = _category_name(sel)

        if not items:
            return f"No item sales found for {start_date} to {end_date}."

        total_rev = sum(r["revenue"] for r in items.values())
        total_qty = sum(r["qty"] for r in items.values())
        ranked = sorted(items.items(), key=lambda kv: -kv[1]["revenue"])

        rows = []
        for name, r in ranked[:top_n]:
            rows.append({
                "Item": name[:35],
                "Category": r["category"][:18],
                "Qty": fmt_number(r["qty"]),
                "Orders": fmt_number(len(r["orders"])),
                "Revenue": fmt_currency(r["revenue"]),
                "% Rev": fmt_pct((r["revenue"] / total_rev * 100) if total_rev else 0, 1),
            })

        lines = [
            f"Toast Item Sales Detail — {start_date} to {end_date}",
            f"{len(items)} distinct items · {fmt_number(total_qty)} units · {fmt_currency(total_rev)} gross",
            f"",
            fmt_table(rows, ["Item", "Category", "Qty", "Orders", "Revenue", "% Rev"]),
        ]
        if len(ranked) > top_n:
            lines.append(f"\n... and {len(ranked) - top_n} more items. Raise top_n to see them.")
        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_item_sales_detail failed: %s", e)
        return f"Error fetching item sales detail: {e}"


@api_retry()
async def toast_waste_by_category(start_date: str, end_date: str, category: str = "") -> str:
    """
    Report voided ("waste") items grouped by menu category, with void reasons.

    Use case: "How many dessert items were marked as waste?" — pass category='dessert'
    (or 'pastr') to filter. Leave blank for all categories.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        category:   Optional case-insensitive substring to filter sales categories.
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        cat_filter = category.strip().lower()

        # category -> {qty, value, reasons:Counter}
        cat_stats: dict = defaultdict(lambda: {"qty": 0, "value": 0.0, "reasons": defaultdict(int)})
        waste_qty = 0  # voids whose reason mentions waste/spoil

        for order in orders:
            for check in order.get("checks", []):
                for sel in check.get("selections", []):
                    if not sel.get("voided"):
                        continue
                    cat = _category_name(sel)
                    if cat_filter and cat_filter not in cat.lower():
                        continue
                    qty = int(sel.get("quantity", 1) or 1)
                    value = float(sel.get("preDiscountPrice", 0) or 0) * qty
                    reason = _void_reason_name(sel.get("voidReason"))
                    st = cat_stats[cat]
                    st["qty"] += qty
                    st["value"] += value
                    st["reasons"][reason] += qty
                    if any(w in reason.lower() for w in ("waste", "spoil")):
                        waste_qty += qty

        if not cat_stats:
            scope = f" matching '{category}'" if category else ""
            return f"No voided items{scope} found for {start_date} to {end_date}."

        total_qty = sum(s["qty"] for s in cat_stats.values())
        total_val = sum(s["value"] for s in cat_stats.values())

        rows = []
        for cat, st in sorted(cat_stats.items(), key=lambda kv: -kv[1]["value"]):
            top_reasons = ", ".join(
                f"{r} ({n})" for r, n in sorted(st["reasons"].items(), key=lambda x: -x[1])[:3]
            )
            rows.append({
                "Category": cat[:20],
                "Voided Qty": fmt_number(st["qty"]),
                "Value": fmt_currency(st["value"]),
                "Top Reasons": top_reasons[:50],
            })

        title = f"Toast Waste / Voids by Category — {start_date} to {end_date}"
        if category:
            title += f"  (filter: '{category}')"
        lines = [
            title,
            f"Total voided: {fmt_number(total_qty)} items · {fmt_currency(total_val)}   "
            f"(of which reason = waste/spoilage: {fmt_number(waste_qty)} items)",
            f"",
            fmt_table(rows, ["Category", "Voided Qty", "Value", "Top Reasons"]),
        ]
        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_waste_by_category failed: %s", e)
        return f"Error fetching waste by category: {e}"


@api_retry()
async def toast_guest_report(start_date: str, end_date: str, min_visits: int = 1) -> str:
    """
    Guestbook report — named guests attached to orders, with visit count and spend.

    Built from check-level customer records (name, email, phone). Anonymous /
    walk-in checks without a guest record are excluded.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        min_visits: Only show guests with at least this many visits (default 1).
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        guests: dict = {}

        for order in orders:
            for check in order.get("checks", []):
                cust = check.get("customer")
                if not cust or not isinstance(cust, dict):
                    continue
                guid = cust.get("guid", "")
                if not guid:
                    continue
                spend = float(check.get("totalAmount", 0) or 0)
                opened = order.get("openedDate")
                try:
                    visit_dt = _to_local_dt(opened) if opened else None
                except Exception:
                    visit_dt = None
                g = guests.setdefault(guid, {
                    "name": f"{cust.get('firstName', '')} {cust.get('lastName', '')}".strip() or "—",
                    "email": cust.get("email", "") or "",
                    "phone": cust.get("phone", "") or "",
                    "visits": 0, "spend": 0.0, "first": visit_dt, "last": visit_dt,
                })
                g["visits"] += 1
                g["spend"] += spend
                if visit_dt:
                    if not g["first"] or visit_dt < g["first"]:
                        g["first"] = visit_dt
                    if not g["last"] or visit_dt > g["last"]:
                        g["last"] = visit_dt

        named = {k: v for k, v in guests.items() if v["visits"] >= min_visits}
        if not named:
            return (f"No guest records (with ≥{min_visits} visits) found for "
                    f"{start_date} to {end_date}.")

        rows = []
        for g in sorted(named.values(), key=lambda x: -x["spend"]):
            rows.append({
                "Guest": g["name"][:24],
                "Contact": (g["email"] or g["phone"])[:28],
                "Visits": str(g["visits"]),
                "Total Spend": fmt_currency(g["spend"]),
                "Avg Check": fmt_currency(g["spend"] / g["visits"] if g["visits"] else 0),
                "Last Visit": g["last"].strftime("%m/%d") if g["last"] else "—",
            })

        total_spend = sum(g["spend"] for g in named.values())
        lines = [
            f"Toast Guest Report — {start_date} to {end_date}",
            f"{len(named)} named guests · {fmt_currency(total_spend)} attributable spend",
            f"",
            fmt_table(rows, ["Guest", "Contact", "Visits", "Total Spend", "Avg Check", "Last Visit"]),
        ]
        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_guest_report failed: %s", e)
        return f"Error fetching guest report: {e}"


@api_retry()
async def toast_payout_reconciliation(start_date: str, end_date: str) -> str:
    """
    Reconstruct expected bank deposits per business date to cross-check against
    actual Toast payouts on your bank statement.

    Net card settlement = (card sales + tips) − processing fees, grouped by the
    payment's business date. Cash deposits (if recorded in Toast cash management)
    are shown separately.

    NOTE: Toast does not expose the actual payout/settlement feed via API, so this
    is reconstructed from payment-level fees. Toast settles on a ~1–2 business-day
    lag, so a given day's net typically lands in your bank 1–2 days later.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)

        # business_date(int yyyymmdd) -> {gross, fees, tips, refunds, count}
        by_date: dict = defaultdict(lambda: {"gross": 0.0, "fees": 0.0, "tips": 0.0,
                                             "refunds": 0.0, "count": 0})

        for order in orders:
            for check in order.get("checks", []):
                for p in check.get("payments", []) or []:
                    if str(p.get("type")) not in ("CREDIT", "GIFTCARD", "OTHER"):
                        continue
                    if p.get("paymentStatus") not in _COLLECTED_PAYMENT_STATUSES:
                        continue
                    bd = p.get("paidBusinessDate")
                    if not bd:
                        continue
                    amount = float(p.get("amount", 0) or 0)
                    tip = float(p.get("tipAmount", 0) or 0)
                    fee = float(p.get("originalProcessingFee", 0) or 0)
                    d = by_date[int(bd)]
                    d["gross"] += amount
                    d["tips"] += tip
                    d["fees"] += fee
                    d["count"] += 1
                    refund = p.get("refund")
                    if isinstance(refund, dict):
                        d["refunds"] += float(refund.get("refundAmount", 0) or 0) + \
                                        float(refund.get("tipRefundAmount", 0) or 0)

        if not by_date:
            return f"No captured card payments found for {start_date} to {end_date}."

        # Cash deposits from cash management (best-effort per business date)
        cash_deposits: dict = defaultdict(float)
        for bd in by_date:
            try:
                deposits = toast_client.get("/cashmgmt/v1/deposits", params={"businessDate": str(bd)})
                if isinstance(deposits, list):
                    for dep in deposits:
                        cash_deposits[bd] += float(dep.get("amount", 0) or 0)
            except Exception:
                pass

        rows = []
        tot_net = tot_fees = tot_cash = 0.0
        for bd in sorted(by_date):
            d = by_date[bd]
            net = d["gross"] + d["tips"] - d["fees"] - d["refunds"]
            tot_net += net
            tot_fees += d["fees"]
            tot_cash += cash_deposits.get(bd, 0.0)
            ds = f"{str(bd)[4:6]}/{str(bd)[6:8]}"
            rows.append({
                "Business Date": ds,
                "Card Sales": fmt_currency(d["gross"] + d["tips"]),
                "Fees": fmt_currency(d["fees"]),
                "Refunds": fmt_currency(d["refunds"]),
                "Net Card Payout": fmt_currency(net),
                "Cash Deposit": fmt_currency(cash_deposits.get(bd, 0.0)),
            })

        cols = ["Business Date", "Card Sales", "Fees", "Refunds", "Net Card Payout", "Cash Deposit"]
        lines = [
            f"Toast Payout Reconciliation — {start_date} to {end_date}",
            f"Reconstructed from payment fees (Toast has no payout API). Settlement lags ~1–2 business days.",
            f"",
            fmt_table(rows, cols),
            f"",
            f"Totals — Net card payout: {fmt_currency(tot_net)}   "
            f"Processing fees: {fmt_currency(tot_fees)}   Cash deposits: {fmt_currency(tot_cash)}",
            f"",
            f"Cross-check 'Net Card Payout' against Toast deposits on your bank statement "
            f"(shifted forward ~1–2 business days).",
        ]
        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_payout_reconciliation failed: %s", e)
        return f"Error reconciling payouts: {e}"


@api_retry()
async def toast_payment_channel_breakdown(start_date: str, end_date: str) -> str:
    """
    Break down sales by order channel — Dine In, Takeout, DoorDash, UberEats,
    online ordering, etc. — using the order's dining option and source.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        # channel -> {orders, revenue}
        chan: dict = defaultdict(lambda: {"orders": 0, "revenue": 0.0})

        for order in orders:
            if order.get("voided"):
                continue
            channel = _dining_option_name(order)
            source = order.get("source", "")
            # Distinguish in-house from integration-driven orders when the dining
            # option name is generic.
            label = channel
            if source and source != "In Store" and channel in ("Unknown", "Delivery", "Takeout"):
                label = f"{channel} ({source})"
            rev = _order_sales(order)  # net Sales basis (matches dashboard dining-option net sales)
            chan[label]["orders"] += 1
            chan[label]["revenue"] += rev

        if not chan:
            return f"No orders found for {start_date} to {end_date}."

        total_orders = sum(c["orders"] for c in chan.values())
        total_rev = sum(c["revenue"] for c in chan.values())

        rows = []
        for label, c in sorted(chan.items(), key=lambda kv: -kv[1]["revenue"]):
            rows.append({
                "Channel": label[:28],
                "Orders": fmt_number(c["orders"]),
                "Revenue": fmt_currency(c["revenue"]),
                "% Rev": fmt_pct((c["revenue"] / total_rev * 100) if total_rev else 0, 1),
                "Avg Order": fmt_currency(c["revenue"] / c["orders"] if c["orders"] else 0),
            })

        lines = [
            f"Toast Payment Channel Breakdown — {start_date} to {end_date}",
            f"{fmt_number(total_orders)} orders · {fmt_currency(total_rev)} revenue",
            f"",
            fmt_table(rows, ["Channel", "Orders", "Revenue", "% Rev", "Avg Order"]),
        ]
        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_payment_channel_breakdown failed: %s", e)
        return f"Error fetching payment channel breakdown: {e}"


@api_retry()
async def toast_payment_type_breakdown(start_date: str, end_date: str) -> str:
    """
    Break down payments by tender type — Cash vs Credit vs other — with a
    card-brand sub-breakdown (Visa, Amex, Mastercard, Discover).

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        by_type: dict = defaultdict(lambda: {"count": 0, "amount": 0.0})
        by_card: dict = defaultdict(lambda: {"count": 0, "amount": 0.0})

        for order in orders:
            for check in order.get("checks", []):
                for p in check.get("payments", []) or []:
                    if p.get("paymentStatus") not in _COLLECTED_PAYMENT_STATUSES:
                        continue
                    ptype = str(p.get("type") or "UNKNOWN").title()
                    amt = float(p.get("amount", 0) or 0) + float(p.get("tipAmount", 0) or 0)
                    by_type[ptype]["count"] += 1
                    by_type[ptype]["amount"] += amt
                    if p.get("cardType"):
                        ct = str(p.get("cardType")).title()
                        by_card[ct]["count"] += 1
                        by_card[ct]["amount"] += amt

        if not by_type:
            return f"No payments found for {start_date} to {end_date}."

        total_amt = sum(t["amount"] for t in by_type.values())
        type_rows = []
        for ptype, t in sorted(by_type.items(), key=lambda kv: -kv[1]["amount"]):
            type_rows.append({
                "Type": ptype,
                "Count": fmt_number(t["count"]),
                "Amount": fmt_currency(t["amount"]),
                "% of Total": fmt_pct((t["amount"] / total_amt * 100) if total_amt else 0, 1),
            })

        lines = [
            f"Toast Payment Type Breakdown — {start_date} to {end_date}",
            f"Total collected (incl. tips): {fmt_currency(total_amt)}",
            f"",
            fmt_table(type_rows, ["Type", "Count", "Amount", "% of Total"]),
        ]

        if by_card:
            card_rows = []
            for ct, c in sorted(by_card.items(), key=lambda kv: -kv[1]["amount"]):
                card_rows.append({
                    "Card": ct,
                    "Count": fmt_number(c["count"]),
                    "Amount": fmt_currency(c["amount"]),
                })
            lines += ["", "Card Brands:", fmt_table(card_rows, ["Card", "Count", "Amount"])]

        return "\n".join(lines)

    except Exception as e:
        logger.error("toast_payment_type_breakdown failed: %s", e)
        return f"Error fetching payment type breakdown: {e}"


@api_retry()
async def toast_sales_breakdown(start_date: str, end_date: str) -> str:
    """
    Full revenue breakdown for a date range — every component from gross item sales
    down to net-of-fees, so you can read whichever figure you need and see exactly
    how they relate (and reconcile against Toast's Sales Summary).

    Ladder:
        Gross Sales (before discounts)
          − Discounts
        = Gross Sales (after discounts)   ← the "sales only" figure; = Toast "Net sales"
          + Tax
          + Tips
        = Gross Revenue (total collected)
          − Card processing fees
        = Net Sales (after processing fees)

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        sales = tax = tips = fees = discounts = 0.0
        orders_counted = 0
        for o in orders:
            if o.get("voided"):
                continue
            sales += _order_sales(o)
            tax += _order_tax(o)
            tips += _order_tips(o)
            fees += _order_processing_fees(o)
            discounts += _order_discounts(o)
            orders_counted += 1

        gross_pre_discount = sales + discounts
        gross_revenue = sales + tax + tips
        net_after_fees = gross_revenue - fees

        return "\n".join([
            f"Toast Sales Breakdown — {start_date} to {end_date}",
            f"",
            f"  Gross Sales (before discounts):    {fmt_currency(gross_pre_discount)}  (approx)",
            f"  Less discounts:                    {fmt_currency(-discounts)}  (approx)",
            f"  ────────────────────────────────",
            f"  GROSS SALES (after discounts):     {fmt_currency(sales)}   ← 'sales only' (exact)",
            f"  Plus tax:                          {fmt_currency(tax)}",
            f"  Plus tips:                         {fmt_currency(tips)}",
            f"  ────────────────────────────────",
            f"  GROSS REVENUE (total collected):   {fmt_currency(gross_revenue)}   ← sales + tax + tip",
            f"  Less card processing fees:         {fmt_currency(-fees)}",
            f"  ────────────────────────────────",
            f"  NET SALES (after processing fees): {fmt_currency(net_after_fees)}",
            f"",
            f"  Orders: {fmt_number(orders_counted)}",
            f"",
            f"  Individual components — Discounts {fmt_currency(discounts)} · Tax {fmt_currency(tax)} · "
            f"Tips {fmt_currency(tips)} · Processing fees {fmt_currency(fees)}",
        ])

    except Exception as e:
        logger.error("toast_sales_breakdown failed: %s", e)
        return f"Error building sales breakdown: {e}"
