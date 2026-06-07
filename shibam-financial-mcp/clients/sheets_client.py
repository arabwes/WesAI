"""Google Sheets API client with schema validation."""
import logging
from typing import Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from config import config

logger = logging.getLogger(__name__)

# Required column headers for each sheet tab — validated before any read/write
INVENTORY_REQUIRED_COLUMNS = [
    "Item Name", "Category", "Unit", "Par Level",
    "Current Count", "Unit Cost ($)", "Supplier", "Last Updated", "Notes",
]
RECIPE_REQUIRED_COLUMNS = [
    "Menu Item", "Ingredient", "Qty Per Serving", "Unit", "Notes",
]
LEDGER_REQUIRED_COLUMNS = [
    "Date", "Order #", "Vendor", "Item", "Qty", "Unit",
    "Unit Cost", "Line Total", "Invoice Total", "Parsed On",
]

_service = None


def _get_credentials() -> Credentials:
    from clients.gmail_client import _SCOPES
    return Credentials(
        token=None,
        refresh_token=config.google_refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=config.google_client_id,
        client_secret=config.google_client_secret,
        scopes=_SCOPES,
    )


def get_service():
    global _service
    if _service is None:
        _service = build("sheets", "v4", credentials=_get_credentials(), cache_discovery=False)
    return _service


def read_range(sheet_id: str, range_notation: str) -> list:
    """Read a range from a Google Sheet and return list of rows (list of lists)."""
    result = get_service().spreadsheets().values().get(
        spreadsheetId=sheet_id,
        range=range_notation,
    ).execute()
    return result.get("values", [])


def append_rows(sheet_id: str, tab_name: str, rows: list):
    """Append rows to the bottom of a sheet tab."""
    get_service().spreadsheets().values().append(
        spreadsheetId=sheet_id,
        range=f"{tab_name}!A1",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": rows},
    ).execute()


def validate_schema(sheet_id: str, tab_name: str, required_columns: list) -> Optional[str]:
    """Check that the first row of a tab contains the required column headers.
    Returns None if OK, or an error message string if columns are missing/renamed."""
    try:
        rows = read_range(sheet_id, f"{tab_name}!1:1")
        if not rows:
            return (
                f"Sheet tab '{tab_name}' appears to be empty. "
                f"Expected columns: {', '.join(required_columns)}"
            )
        actual = [str(c).strip() for c in rows[0]]
        missing = [col for col in required_columns if col not in actual]
        if missing:
            return (
                f"Sheet tab '{tab_name}' is missing required columns: {', '.join(missing)}.\n"
                f"Found columns: {', '.join(actual)}\n"
                f"Required columns: {', '.join(required_columns)}\n"
                "Please check the README for the correct column names and do not rename headers."
            )
        return None
    except Exception as e:
        return f"Could not read sheet '{tab_name}': {e}"


def sheet_to_dicts(sheet_id: str, tab_name: str, required_columns: list) -> tuple:
    """Read a sheet tab and return (error_string_or_None, list_of_dicts).
    Always validates schema before returning data."""
    error = validate_schema(sheet_id, tab_name, required_columns)
    if error:
        return error, []
    rows = read_range(sheet_id, f"{tab_name}!A:Z")
    if not rows:
        return None, []
    headers = rows[0]
    return None, [
        {headers[i]: row[i] if i < len(row) else "" for i in range(len(headers))}
        for row in rows[1:]
    ]


def ensure_ledger_tab(sheet_id: str):
    """Create the Ledger tab with correct headers if it doesn't already exist."""
    try:
        validate_schema(sheet_id, "Ledger", LEDGER_REQUIRED_COLUMNS)
        return  # Tab exists with correct headers
    except Exception:
        pass  # Tab may not exist — create it
    try:
        # Add the sheet tab
        get_service().spreadsheets().batchUpdate(
            spreadsheetId=sheet_id,
            body={"requests": [{"addSheet": {"properties": {"title": "Ledger"}}}]},
        ).execute()
        # Write headers
        get_service().spreadsheets().values().update(
            spreadsheetId=sheet_id,
            range="Ledger!A1",
            valueInputOption="RAW",
            body={"values": [LEDGER_REQUIRED_COLUMNS]},
        ).execute()
        logger.info("Created Ledger tab in sheet %s", sheet_id)
    except Exception as e:
        logger.warning("Could not create Ledger tab: %s", e)
