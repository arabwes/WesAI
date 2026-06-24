"""Google Sheets inventory MCP tools — 5 tools for current stock, valuation, low stock, recipes, and reorder lists.

Required sheet: "Shibam Inventory" Google Sheet with tabs:
  - Inventory (columns: Item Name, Category, Unit, Par Level, Current Count, Unit Cost ($), Supplier, Last Updated, Notes)
  - Recipes (columns: Menu Item, Ingredient, Qty Per Serving, Unit, Notes)

The tools fail gracefully with a clear schema error if columns are missing or renamed.
"""
import logging
from collections import defaultdict
from clients.sheets_client import sheet_to_dicts, INVENTORY_REQUIRED_COLUMNS, RECIPE_REQUIRED_COLUMNS
from config import config
from utils.formatting import fmt_currency, fmt_number, fmt_pct, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)


def _check_sheets() -> str | None:
    if not config.sheets_ready:
        return "Google Sheets not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, and GOOGLE_SHEETS_INVENTORY_ID to your Railway environment variables."
    return None


def _parse_float(val) -> float:
    try:
        return float(str(val).replace("$", "").replace(",", "").strip() or 0)
    except (ValueError, TypeError):
        return 0.0


@api_retry()
async def inventory_current(category: str = "") -> str:
    """
    Fetch all current inventory from the Shibam Inventory Google Sheet.

    Returns item name, category, unit, current count, unit cost, and last updated date.

    Args:
        category: optional — filter to one category (e.g., "Beans", "Dairy", "Syrups")
    """
    err = _check_sheets()
    if err: return err
    try:
        error, rows = sheet_to_dicts(config.sheets_inventory_id, "Inventory", INVENTORY_REQUIRED_COLUMNS)
        if error:
            return f"Inventory sheet error: {error}"
        if not rows:
            return "Inventory sheet is empty. Add items to the Inventory tab."

        if category:
            rows = [r for r in rows if category.lower() in r.get("Category", "").lower()]
            if not rows:
                return f"No inventory items found in category '{category}'."

        table_rows = [{
            "Item Name": r.get("Item Name", "")[:35],
            "Category": r.get("Category", ""),
            "Unit": r.get("Unit", ""),
            "Count": r.get("Current Count", ""),
            "Par Level": r.get("Par Level", ""),
            "Unit Cost": r.get("Unit Cost ($)", ""),
            "Last Updated": r.get("Last Updated", ""),
        } for r in rows if r.get("Item Name")]

        cols = ["Item Name", "Category", "Unit", "Count", "Par Level", "Unit Cost", "Last Updated"]
        header = f"Inventory — {len(table_rows)} items"
        if category:
            header += f" (category: {category})"
        return header + "\n\n" + fmt_table(table_rows, cols)

    except Exception as e:
        logger.error("inventory_current failed: %s", e)
        return f"Error fetching inventory: {e}"


@api_retry()
async def inventory_valuation() -> str:
    """
    Calculate total estimated inventory value (current count × unit cost) by category.

    Returns total value and breakdown by category.
    """
    err = _check_sheets()
    if err: return err
    try:
        error, rows = sheet_to_dicts(config.sheets_inventory_id, "Inventory", INVENTORY_REQUIRED_COLUMNS)
        if error:
            return f"Inventory sheet error: {error}"
        if not rows:
            return "Inventory sheet is empty."

        category_value: dict = defaultdict(float)
        category_items: dict = defaultdict(int)
        total = 0.0

        for row in rows:
            if not row.get("Item Name"):
                continue
            count = _parse_float(row.get("Current Count", 0))
            unit_cost = _parse_float(row.get("Unit Cost ($)", 0))
            value = count * unit_cost
            cat = row.get("Category", "Uncategorized")
            category_value[cat] += value
            category_items[cat] += 1
            total += value

        table_rows = []
        for cat, val in sorted(category_value.items(), key=lambda x: -x[1]):
            pct = (val / total * 100) if total else 0
            table_rows.append({
                "Category": cat,
                "Items": str(category_items[cat]),
                "Est. Value": fmt_currency(val),
                "% of Total": fmt_pct(pct, 1),
            })

        cols = ["Category", "Items", "Est. Value", "% of Total"]
        return (
            f"Inventory Valuation\n"
            f"Total estimated inventory value: {fmt_currency(total)}\n\n"
            + fmt_table(table_rows, cols)
            + "\n\nNote: Values are estimates based on the unit costs in the sheet. Update Unit Cost ($) regularly."
        )

    except Exception as e:
        logger.error("inventory_valuation failed: %s", e)
        return f"Error calculating inventory valuation: {e}"


@api_retry()
async def inventory_low_stock() -> str:
    """
    Find all inventory items where Current Count is below Par Level.

    Returns items sorted by how critically short they are (most urgent first).
    Use case: generate reorder list before placing supplier orders.
    """
    err = _check_sheets()
    if err: return err
    try:
        error, rows = sheet_to_dicts(config.sheets_inventory_id, "Inventory", INVENTORY_REQUIRED_COLUMNS)
        if error:
            return f"Inventory sheet error: {error}"
        if not rows:
            return "Inventory sheet is empty."

        low = []
        for row in rows:
            if not row.get("Item Name"):
                continue
            count = _parse_float(row.get("Current Count", 0))
            par = _parse_float(row.get("Par Level", 0))
            if par > 0 and count < par:
                units_short = par - count
                low.append({
                    "Item": row.get("Item Name", "")[:35],
                    "Category": row.get("Category", ""),
                    "Count": fmt_number(count, 1),
                    "Par": fmt_number(par, 1),
                    "Short": fmt_number(units_short, 1),
                    "Unit": row.get("Unit", ""),
                    "Supplier": row.get("Supplier", ""),
                    "_urgency": units_short / par,
                })

        if not low:
            return "✅  All inventory items are above par level. No reorders needed."

        low.sort(key=lambda x: -x["_urgency"])
        for r in low:
            del r["_urgency"]

        cols = ["Item", "Category", "Count", "Par", "Short", "Unit", "Supplier"]
        return (
            f"Inventory Low Stock Alert — {len(low)} items below par level\n\n"
            + fmt_table(low, cols)
            + f"\n\nRun inventory_reorder_list to see orders grouped by supplier."
        )

    except Exception as e:
        logger.error("inventory_low_stock failed: %s", e)
        return f"Error checking inventory low stock: {e}"


@api_retry()
async def inventory_vs_sales(start_date: str, end_date: str) -> str:
    """
    Cross-reference Toast sales with inventory Recipes to estimate ingredient consumption.
    Flags significant variance between expected and actual inventory drawdown.

    Requires the Recipes tab in the inventory sheet to be filled in.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    err = _check_sheets()
    if err: return err
    try:
        # Read inventory and recipes
        inv_error, inv_rows = sheet_to_dicts(config.sheets_inventory_id, "Inventory", INVENTORY_REQUIRED_COLUMNS)
        if inv_error:
            return f"Inventory sheet error: {inv_error}"

        rec_error, rec_rows = sheet_to_dicts(config.sheets_inventory_id, "Recipes", RECIPE_REQUIRED_COLUMNS)
        if rec_error:
            return (
                f"Recipes tab error: {rec_error}\n\n"
                "To use inventory_vs_sales, fill in the Recipes tab with:\n"
                "  Menu Item | Ingredient | Qty Per Serving | Unit | Notes\n"
                "See README for the full template."
            )

        if not rec_rows:
            return "Recipes tab is empty. Add ingredient mappings to enable inventory vs sales comparison."

        # Build ingredient consumption map from recipes × sales
        # sales requires Toast; handle gracefully if pending
        if config.toast_api_pending:
            return (
                "Toast API is pending. inventory_vs_sales requires Toast sales data "
                "to calculate expected ingredient consumption.\n"
                "Set TOAST_API_PENDING=false once Toast credentials are configured."
            )

        # Fetch Toast item sales
        from clients import toast_client
        from utils.date_helpers import to_toast_datetime
        from datetime import date as d_cls
        s_date, e_date = to_start_end("custom", start_date, end_date)
        params = {
            "startDate": to_toast_datetime(s_date),
            "endDate": to_toast_datetime(e_date, end_of_day=True),
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

        # Count items sold
        item_qty: dict = defaultdict(int)
        for order in all_orders:
            for check in order.get("checks", []):
                for selection in check.get("selections", []):
                    name = selection.get("displayName", "")
                    qty = int(selection.get("quantity", 1) or 1)
                    item_qty[name] += qty

        # Calculate expected ingredient consumption
        expected_consumption: dict = defaultdict(float)
        for recipe_row in rec_rows:
            menu_item = recipe_row.get("Menu Item", "")
            ingredient = recipe_row.get("Ingredient", "")
            qty_per_serving = _parse_float(recipe_row.get("Qty Per Serving", 0))
            if not menu_item or not ingredient or not qty_per_serving:
                continue
            # Find matching sales
            sold_qty = sum(v for k, v in item_qty.items() if menu_item.lower() in k.lower())
            expected_consumption[ingredient] += sold_qty * qty_per_serving

        if not expected_consumption:
            return "No matching sales found for items in the Recipes tab. Verify that Menu Item names match Toast item names exactly."

        # Build inventory map for current counts
        inv_map = {r.get("Item Name", ""): r for r in inv_rows if r.get("Item Name")}

        rows = []
        for ingredient, expected in sorted(expected_consumption.items(), key=lambda x: -x[1]):
            inv_row = inv_map.get(ingredient, {})
            current = _parse_float(inv_row.get("Current Count", 0))
            unit = inv_row.get("Unit", "")
            variance_pct = ((current - expected) / expected * 100) if expected else 0
            flag = ""
            if variance_pct < -20:
                flag = "⚠️ Possible shortage/shrinkage"
            elif variance_pct > 50:
                flag = "⚠️ Higher than expected — check recipe qty"
            rows.append({
                "Ingredient": ingredient[:30],
                "Expected Used": fmt_number(expected, 1) + f" {unit}",
                "Current Count": fmt_number(current, 1) + f" {unit}" if inv_row else "Not in inventory",
                "Variance": fmt_pct(variance_pct, 0),
                "Flag": flag,
            })

        cols = ["Ingredient", "Expected Used", "Current Count", "Variance", "Flag"]
        return (
            f"Inventory vs Sales — {start_date} to {end_date}\n"
            f"Based on {len(all_orders)} orders and {len(rec_rows)} recipe mappings\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        logger.error("inventory_vs_sales failed: %s", e)
        return f"Error running inventory vs sales: {e}"


@api_retry()
async def inventory_reorder_list() -> str:
    """
    Generate a reorder list grouped by supplier.

    For each low-stock item, shows current count, par level, and suggested order quantity
    (par level × 1.5 minus current count).
    """
    err = _check_sheets()
    if err: return err
    try:
        error, rows = sheet_to_dicts(config.sheets_inventory_id, "Inventory", INVENTORY_REQUIRED_COLUMNS)
        if error:
            return f"Inventory sheet error: {error}"
        if not rows:
            return "Inventory sheet is empty."

        by_supplier: dict = defaultdict(list)
        for row in rows:
            if not row.get("Item Name"):
                continue
            count = _parse_float(row.get("Current Count", 0))
            par = _parse_float(row.get("Par Level", 0))
            if par > 0 and count < par:
                suggested = max(0, (par * 1.5) - count)
                supplier = row.get("Supplier", "Unknown Supplier") or "Unknown Supplier"
                by_supplier[supplier].append({
                    "Item": row.get("Item Name", "")[:35],
                    "Unit": row.get("Unit", ""),
                    "Count": fmt_number(count, 1),
                    "Par": fmt_number(par, 1),
                    "Order Qty": fmt_number(suggested, 1),
                })

        if not by_supplier:
            return "✅  All inventory items are above par level. No reorders needed."

        lines = [f"Inventory Reorder List\n"]
        for supplier in sorted(by_supplier.keys()):
            items = by_supplier[supplier]
            lines += [
                f"── {supplier.upper()} ──────────────────────────────────────",
                fmt_table(items, ["Item", "Unit", "Count", "Par", "Order Qty"]),
                "",
            ]

        lines.append(f"Total suppliers to order from: {len(by_supplier)}")
        return "\n".join(lines)

    except Exception as e:
        logger.error("inventory_reorder_list failed: %s", e)
        return f"Error generating inventory reorder list: {e}"
