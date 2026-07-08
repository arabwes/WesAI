"""Toast POS MCP tools — 5 tools covering sales, top items, weekend/evening share, hourly heatmap, and category breakdown.

All tools check TOAST_API_PENDING before making any API calls.
Set TOAST_API_PENDING=false in your .env once Toast API access is approved.
"""
import logging
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Optional
from mcp_common.errors import safe_error
from mcp_common.tenant import maybe_tenant
from clients import toast_client
from config import config, NotConfiguredError
from utils.date_helpers import to_start_end, to_toast_datetime
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

# Toast timestamps are UTC; convert to local time before binning by hour/day so
# heatmaps, day-of-week splits, and the evening-peak window reflect store-local time.
_RESTAURANT_TZ = ZoneInfo("America/New_York")


def _to_local_dt(value) -> datetime:
    """Parse a Toast timestamp (ISO UTC string or epoch ms) to a naive local datetime."""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).astimezone(_RESTAURANT_TZ).replace(tzinfo=None)
    iso = str(value).replace("+0000", "+00:00").replace("Z", "+00:00")
    return datetime.fromisoformat(iso).astimezone(_RESTAURANT_TZ).replace(tzinfo=None)

# Cache order fetches — multiple tools with the same date range share one fetch.
# Live ranges (including today) use a short TTL since orders are still accumulating;
# fully-closed past ranges never change, so they cache far longer.
_orders_cache: dict = {}
_CACHE_TTL = 300            # ranges that include today
_CLOSED_RANGE_TTL = 86400  # ranges entirely in the past (orders are final)

# Config GUID → name maps. Order payloads carry salesCategory/diningOption as
# GUID-only references (the name field is null), so resolve names from /config/v2
# once and cache for the process lifetime.
_config_maps: dict = {}


def _config_map(path: str) -> dict:
    """Return {guid: name} for a /config/v2 collection, cached for the process lifetime.
    Falls back to an empty map (callers degrade to GUIDs/'Uncategorized') on error."""
    if path in _config_maps:
        return _config_maps[path]
    mapping: dict = {}
    try:
        items = toast_client.get(path)
        if isinstance(items, list):
            for it in items:
                guid = it.get("guid", "")
                name = it.get("name") or ""
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

_PENDING_MSG = (
    "Toast API access is pending approval.\n"
    "To enable Toast tools:\n"
    "  1. Apply at developers.toasttab.com\n"
    "  2. Once approved, add TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, "
    "and TOAST_RESTAURANT_GUID to your environment variables.\n"
    "  3. Set TOAST_API_PENDING=false\n"
    "All other tools continue to work normally while this is pending."
)

# Default known-top-seller list; overridable per tenant via the
# "top_performer_items" setting (list of item names, case-insensitive).
_TOP_PERFORMERS = ["pistachio latte", "shibam latte", "adeni tea", "milk cake"]


def _setting(key, default):
    t = maybe_tenant()
    return t.setting(key, default) if t else default


def _top_performers() -> set:
    return {str(i).lower() for i in _setting("top_performer_items", _TOP_PERFORMERS)}


def _check_pending() -> Optional[str]:
    if config.toast_api_pending:
        return _PENDING_MSG
    return None


_orders_fetch_lock = threading.Lock()


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
    calendar-day semantics the tools already rely on.
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
    """DEPRECATED for revenue: check.totalAmount = sales + tax + tips (total collected).
    Use _order_sales for the 'sales' figure that matches the Toast dashboard."""
    return sum(float(c.get("totalAmount", 0) or 0) for c in order.get("checks", []))


def _order_sales(order: dict) -> float:
    """Gross Sales after discounts (the 'sales only' figure; excludes tax & tips).
    check.amount = Toast 'Net sales' — verified against the Sales Summary export."""
    return sum(float(c.get("amount", 0) or 0) for c in order.get("checks", []))


@api_retry()
async def toast_sales_summary(start_date: str, end_date: str) -> str:
    """
    Fetch Toast POS sales summary for a date range.

    Returns total revenue, total transactions, average ticket size,
    and revenue broken down by day of week.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        orders = _fetch_orders(start_date, end_date)
        if not orders:
            return f"No Toast orders found between {start_date} and {end_date}."

        total_revenue = 0.0
        by_dow = defaultdict(float)
        dow_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

        for order in orders:
            amount = _order_sales(order)
            total_revenue += amount
            opened = order.get("openedDate", "")
            if opened:
                dt = _to_local_dt(opened)
                by_dow[dt.weekday()] += amount

        transactions = len(orders)
        avg_ticket = total_revenue / transactions if transactions else 0

        lines = [
            f"Toast Sales Summary — {start_date} to {end_date}",
            f"",
            f"Net Sales (excl. tax & tips): {fmt_currency(total_revenue)}",
            f"Total Transactions:           {fmt_number(transactions)}",
            f"Average Ticket:               {fmt_currency(avg_ticket)}",
            f"",
            f"Net Sales by Day of Week (matches Toast dashboard; for tax/tips/fees use toast_sales_breakdown):",
        ]
        for dow_idx in range(7):
            rev = by_dow.get(dow_idx, 0)
            pct = (rev / total_revenue * 100) if total_revenue else 0
            lines.append(f"  {dow_names[dow_idx]:<12} {fmt_currency(rev)}  ({fmt_pct(pct, 1)})")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Toast sales summary")


@api_retry()
async def toast_top_items(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch the top 10 Toast menu items ranked by revenue and by quantity sold.

    Flags if any of the business's known top sellers (configurable per tenant)
    have dropped out of the top 10.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        from utils.date_helpers import to_start_end
        start, end = to_start_end(date_range, start_date, end_date)
        orders = _fetch_orders(str(start), str(end))

        item_revenue: dict = defaultdict(float)
        item_qty: dict = defaultdict(int)

        for order in orders:
            for check in order.get("checks", []):
                for selection in check.get("selections", []):
                    name = selection.get("displayName", "Unknown")
                    qty = int(selection.get("quantity", 1) or 1)
                    price = float(selection.get("preDiscountPrice", 0) or 0) * qty
                    item_revenue[name] += price
                    item_qty[name] += qty

        top_by_rev = sorted(item_revenue.items(), key=lambda x: -x[1])[:10]
        top_by_qty = sorted(item_qty.items(), key=lambda x: -x[1])[:10]

        top_performers = _top_performers()
        top_rev_names = {n.lower() for n, _ in top_by_rev}
        top_qty_names = {n.lower() for n, _ in top_by_qty}
        missing_from_rev = [p for p in top_performers if p not in top_rev_names]
        missing_from_qty = [p for p in top_performers if p not in top_qty_names]

        rev_rows = [{"Rank": str(i + 1), "Item": n, "Revenue": fmt_currency(v)} for i, (n, v) in enumerate(top_by_rev)]
        qty_rows = [{"Rank": str(i + 1), "Item": n, "Qty Sold": fmt_number(q)} for i, (n, q) in enumerate(top_by_qty)]

        lines = [
            f"Toast Top Items — {date_range} ({start} to {end})",
            f"",
            f"TOP 10 BY REVENUE:",
            fmt_table(rev_rows, ["Rank", "Item", "Revenue"]),
            f"",
            f"TOP 10 BY QUANTITY SOLD:",
            fmt_table(qty_rows, ["Rank", "Item", "Qty Sold"]),
        ]
        if missing_from_rev:
            lines.append(f"\n⚠️  Known top performers missing from revenue top 10: {', '.join(missing_from_rev)}")
        if missing_from_qty:
            lines.append(f"⚠️  Known top performers missing from quantity top 10: {', '.join(missing_from_qty)}")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Toast top items")


@api_retry()
async def toast_weekend_evening_share(
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch Friday and Saturday 6PM–midnight revenue as a percentage of total weekly revenue.

    Weekend evenings are typically peak trading for this business — this is a core KPI.

    Args:
        start_date: YYYY-MM-DD (defaults to start of current week if not provided)
        end_date:   YYYY-MM-DD (defaults to today if not provided)
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        from datetime import date
        if not start_date:
            today = date.today()
            start_date = str(today - timedelta(days=today.weekday()))
        if not end_date:
            end_date = str(date.today())

        orders = _fetch_orders(start_date, end_date)
        total = 0.0
        weekend_evening = 0.0

        for order in orders:
            amount = _order_sales(order)
            total += amount
            opened = order.get("openedDate", "")
            if opened:
                dt = _to_local_dt(opened)
                # Friday=4, Saturday=5 in Python weekday(); hour 18-23 (local)
                if dt.weekday() in (4, 5) and 18 <= dt.hour <= 23:
                    weekend_evening += amount

        share_pct = (weekend_evening / total * 100) if total else 0
        lines = [
            f"Toast Weekend Evening Revenue Share — {start_date} to {end_date}",
            f"",
            f"Total Revenue (period):          {fmt_currency(total)}",
            f"Fri/Sat 6PM–Midnight Revenue:    {fmt_currency(weekend_evening)}",
            f"Weekend Evening Share:           {fmt_pct(share_pct)}",
            f"",
            f"Note: Weekend evenings (Fri/Sat 6PM–midnight) are the tracked peak trading window.",
        ]
        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Toast weekend evening share")


@api_retry()
async def toast_hourly_heatmap(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch average revenue by hour of day × day of week to identify peak periods.

    Returns a 7×24 heatmap of average hourly revenue. Best hours are highlighted.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        from utils.date_helpers import to_start_end
        start, end = to_start_end(date_range, start_date, end_date)
        orders = _fetch_orders(str(start), str(end))

        # Accumulate revenue and order count per (dow, hour) bucket
        revenue_grid: dict = defaultdict(float)
        count_grid: dict = defaultdict(int)
        dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

        for order in orders:
            amount = _order_sales(order)
            opened = order.get("openedDate", "")
            if opened and amount > 0:
                dt = _to_local_dt(opened)
                key = (dt.weekday(), dt.hour)
                revenue_grid[key] += amount
                count_grid[key] += 1

        # Find overall max for relative comparison
        all_avgs = []
        for dow in range(7):
            for hour in range(24):
                key = (dow, hour)
                if count_grid[key] > 0:
                    all_avgs.append(revenue_grid[key] / count_grid[key])
        max_avg = max(all_avgs) if all_avgs else 1

        lines = [
            f"Toast Hourly Revenue Heatmap — {date_range} ({start} to {end})",
            f"Average revenue per hour. ● = top 25% / ◑ = top 50% / ○ = below median\n",
        ]
        hour_header = "     " + "  ".join(f"{h:02d}" for h in range(6, 24))
        lines.append(hour_header)

        for dow in range(7):
            row = f"{dow_names[dow]}  "
            for hour in range(6, 24):  # Show 6AM–midnight
                key = (dow, hour)
                if count_grid[key] == 0:
                    row += "    "
                    continue
                avg = revenue_grid[key] / count_grid[key]
                ratio = avg / max_avg
                if ratio >= 0.75:
                    sym = " ● "
                elif ratio >= 0.50:
                    sym = " ◑ "
                elif ratio >= 0.25:
                    sym = " ○ "
                else:
                    sym = " · "
                row += sym + " "
            lines.append(row)

        # Find and report top 5 hours
        top_slots = sorted(
            [(dow, hour, revenue_grid[(dow, hour)] / count_grid[(dow, hour)])
             for dow in range(7) for hour in range(24) if count_grid[(dow, hour)] > 0],
            key=lambda x: -x[2],
        )[:5]
        lines += ["", "Top 5 revenue hours:"]
        for dow, hour, avg in top_slots:
            lines.append(f"  {dow_names[dow]} {hour:02d}:00  avg {fmt_currency(avg)}/hr")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "building Toast hourly heatmap")


@api_retry()
async def toast_category_breakdown(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch Toast revenue split by menu category (e.g. espresso bar, pastries).

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    pending = _check_pending()
    if pending:
        return pending
    try:
        from utils.date_helpers import to_start_end
        start, end = to_start_end(date_range, start_date, end_date)
        orders = _fetch_orders(str(start), str(end))

        cat_revenue: dict = defaultdict(float)
        cat_qty: dict = defaultdict(int)

        for order in orders:
            for check in order.get("checks", []):
                for selection in check.get("selections", []):
                    # salesCategory is a GUID-only ref in order payloads — resolve the name.
                    category = _category_name(selection)
                    qty = int(selection.get("quantity", 1) or 1)
                    price = float(selection.get("preDiscountPrice", 0) or 0) * qty
                    cat_revenue[category] += price
                    cat_qty[category] += qty

        total = sum(cat_revenue.values())
        if total == 0:
            return f"No category revenue data found for {date_range}."

        rows = []
        for cat, rev in sorted(cat_revenue.items(), key=lambda x: -x[1]):
            pct = (rev / total * 100) if total else 0
            rows.append({
                "Category": cat,
                "Revenue": fmt_currency(rev),
                "% of Total": fmt_pct(pct, 1),
                "Items Sold": fmt_number(cat_qty[cat]),
            })

        cols = ["Category", "Revenue", "% of Total", "Items Sold"]
        return (
            f"Toast Category Breakdown — {date_range} ({start} to {end})\n"
            f"Total: {fmt_currency(total)}\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Toast category breakdown")
