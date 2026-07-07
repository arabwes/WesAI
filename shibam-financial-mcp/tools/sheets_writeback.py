"""Google Sheets write-back tool — logs weekly labor/sales summaries to the Financial Dashboard sheet."""
import logging
from clients.sheets_client import ensure_tab, append_rows, LABOR_LOG_REQUIRED_COLUMNS
from config import config
from utils.retry import api_retry

from mcp_common.errors import safe_error, requires_scope
from config import NotConfiguredError

logger = logging.getLogger(__name__)


def _check_sheets() -> str | None:
    if not config.google_ready:
        return "Google Sheets not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN to your Railway environment variables."
    if not config.financial_dashboard_sheet_id:
        return "FINANCIAL_DASHBOARD_SHEET_ID is not set. Create the Financial Dashboard Google Sheet, copy its ID from the URL, and add it to your Railway environment variables."
    return None


@requires_scope("mutate")
@api_retry()
async def sheets_write_labor_report(
    week_ending: str,
    total_revenue: float,
    total_labor_cost: float,
    labor_pct: float,
    total_labor_hours: float,
    notes: str = "",
) -> str:
    """
    Append a weekly labor vs. sales summary row to the Financial Dashboard Google Sheet.

    Creates the "Labor Log" tab automatically if it doesn't exist.

    Args:
        week_ending:        YYYY-MM-DD
        total_revenue:       total revenue for the week
        total_labor_cost:    total labor cost for the week
        labor_pct:           labor cost as % of revenue, e.g. 27.04 for 27.04%
        total_labor_hours:   total labor hours for the week
        notes:               optional free-text note
    """
    err = _check_sheets()
    if err:
        return err
    try:
        ensure_tab(config.financial_dashboard_sheet_id, "Labor Log", LABOR_LOG_REQUIRED_COLUMNS)
        append_rows(config.financial_dashboard_sheet_id, "Labor Log", [[
            week_ending,
            round(total_revenue, 2),
            round(total_labor_cost, 2),
            round(labor_pct, 2),
            round(total_labor_hours, 1),
            notes,
        ]])
        return f"Logged labor report for week ending {week_ending} to the Labor Log tab."
    except Exception as e:
        logger.error("sheets_write_labor_report failed: %s", e)
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "writing labor report to Google Sheets")
