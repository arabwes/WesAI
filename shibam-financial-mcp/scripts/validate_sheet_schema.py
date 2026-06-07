"""
Validates that your Google Sheets inventory document has the correct column structure
before running the MCP server.

Run once after creating your sheet:
    python scripts/validate_sheet_schema.py

Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, and
GOOGLE_SHEETS_INVENTORY_ID to be set in .env.
"""
import sys
from dotenv import load_dotenv
load_dotenv()

from clients.sheets_client import validate_schema, INVENTORY_REQUIRED_COLUMNS, RECIPE_REQUIRED_COLUMNS
from config import config

print("Validating Shibam Inventory Google Sheet...\n")

errors = []

# Check Inventory tab
inv_error = validate_schema(config.sheets_inventory_id, "Inventory", INVENTORY_REQUIRED_COLUMNS)
if inv_error:
    print(f"❌  Inventory tab: {inv_error}\n")
    errors.append("Inventory")
else:
    print(f"✅  Inventory tab — all required columns present")

# Check Recipes tab
rec_error = validate_schema(config.sheets_inventory_id, "Recipes", RECIPE_REQUIRED_COLUMNS)
if rec_error:
    print(f"⚠️   Recipes tab: {rec_error}\n")
    print("    Note: Recipes tab is optional but required for inventory_vs_sales tool.")
else:
    print(f"✅  Recipes tab — all required columns present")

if errors:
    print(f"\n❌  Fix the above errors before running the server.")
    print("    See README for the correct column names and templates.")
    sys.exit(1)
else:
    print("\n✅  Sheet schema is valid. Server can read inventory data.")
