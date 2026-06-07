# Shibam Coffee — Financial MCP Server

This server connects Claude.ai to Shibam Coffee's live financial data.
Once connected, you can ask Claude questions like:
- "Show me the P&L for May"
- "What vendors did we spend the most with last month?"
- "Parse my vendor invoices from the last 30 days"
- "What inventory items need to be reordered?"
- "Give me the weekly financial digest"
- "Run the monthly close checklist for May"
- "What's our labor percentage this week?"

This is a **separate server** from `shibam-marketing-mcp`. Add both to Claude.ai
for complete coverage of marketing + financial data.

---

## What This Server Does

| Data Source | Tools |
|------------|-------|
| QuickBooks | Transaction detail, receipt attachments, P&L summary, vendor spend, unreconciled check, cash flow |
| Toast (financial) | Modifier revenue, labor summary, labor vs revenue, void/refund summary, tips |
| Gmail Invoice Parser | Parse vendor PDFs with Claude AI, vendor spend summary, reconciliation check, ledger sync |
| Payroll | Payroll summary, by role, labor %, schedule overview |
| WhenIWork | Schedule view, labor forecast vs actuals, schedule cost |
| Google Sheets | Current inventory, valuation, low stock, inventory vs sales, reorder list |
| **Composite** | **Weekly financial digest** + **Monthly close checklist** |

Total: **29 tools**

Toast tools return a helpful setup message until API access is approved.

---

## Relationship to shibam-marketing-mcp

| Server | Handles |
|--------|---------|
| `shibam-marketing-mcp` | Google Ads, Meta Ads, Instagram, Google Business Profile, Toast sales/revenue |
| `shibam-financial-mcp` | QuickBooks, Gmail invoices, payroll, WhenIWork, inventory, Toast labor/financial |

Toast credentials are shared — use the same `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`,
and `TOAST_RESTAURANT_GUID` values in both servers' `.env` files.

---

## Local Setup

### 1. Clone and install

```bash
cd shibam-financial-mcp
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure environment

```bash
cp .env.example .env
# Open .env and fill in your credentials (see credential guide below)
```

### 3. Generate Google refresh token (one-time — sign in as yemenicoffeeco@gmail.com)

```bash
python scripts/get_google_token.py
# Browser will open — sign in as yemenicoffeeco@gmail.com
# Copy the GOOGLE_REFRESH_TOKEN it prints and paste into .env
```

### 4. Generate QuickBooks refresh token (one-time)

```bash
python scripts/get_qb_token.py
# Browser opens → sign in with the QuickBooks account for Shibam Coffee
# Copy QB_REFRESH_TOKEN and QB_REALM_ID into .env
```

### 5. Set up Google Sheets (one-time)

Create two Google Sheets:
- **Shibam Inventory** — for inventory tracking
- **Invoice Ledger** — for parsed vendor invoices (auto-created by the MCP)

Copy the Sheet IDs from the URL (`docs.google.com/spreadsheets/d/{SHEET_ID}/edit`)
and add them to `.env` as `GOOGLE_SHEETS_INVENTORY_ID` and `GOOGLE_SHEETS_LEDGER_ID`.

See the **Google Sheets Templates** section below for the required column structure.

### 6. Validate sheet schema

```bash
python scripts/validate_sheet_schema.py
# Confirms your inventory sheet has the correct column names before starting
```

### 7. Start the server

```bash
python main.py
# Server starts on http://localhost:8001
```

### 8. Test

```bash
curl http://localhost:8001/
# Should return: {"status":"ok","server":"shibam-financial-mcp",...}
```

---

## How to Get Each Credential

### QuickBooks Online

| Variable | Where to Get It |
|----------|----------------|
| `QB_CLIENT_ID` | developer.intuit.com → My Apps → Keys & Credentials |
| `QB_CLIENT_SECRET` | Same page |
| `QB_REFRESH_TOKEN` | Run `python scripts/get_qb_token.py` |
| `QB_REALM_ID` | Printed by `get_qb_token.py` — also in your QBO URL |

**Intuit App Setup:**
1. Go to developer.intuit.com → Create an app
2. Select **QuickBooks Online and Payments**
3. Under Keys & OAuth, add `http://localhost:8080/callback` as a redirect URI
4. Enable the **Accounting** scope (and **Payroll** if you want payroll tools)

### Gmail + Google Sheets

| Variable | Where to Get It |
|----------|----------------|
| `GOOGLE_CLIENT_ID` | console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client |
| `GOOGLE_CLIENT_SECRET` | Same page |
| `GOOGLE_REFRESH_TOKEN` | Run `python scripts/get_google_token.py` (sign in as yemenicoffeeco@gmail.com) |
| `GOOGLE_SHEETS_INVENTORY_ID` | From the URL of your Shibam Inventory Google Sheet |
| `GOOGLE_SHEETS_LEDGER_ID` | From the URL of your Invoice Ledger Google Sheet (or leave blank — auto-created) |

**Enable in Google Cloud Console:**
- Gmail API
- Google Sheets API

**OAuth consent screen:** Add yemenicoffeeco@gmail.com as a test user until the app is verified.

### Claude API (for PDF invoice parsing)

| Variable | Where to Get It |
|----------|----------------|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys → Create Key |

The invoice parser uses `claude-opus-4-8` for best accuracy on messy invoice layouts.

### WhenIWork

| Variable | Where to Get It |
|----------|----------------|
| `WHENIWORK_API_KEY` | WhenIWork web app → Account Settings → API → Generate API Key |
| `WHENIWORK_ACCOUNT_ID` | Visible in WhenIWork settings or the account URL |

### Toast POS (same as shibam-marketing-mcp)

| Variable | Notes |
|----------|-------|
| `TOAST_API_PENDING` | Set `true` until approved, then `false` |
| `TOAST_CLIENT_ID` | From developers.toasttab.com — same value as marketing server |
| `TOAST_CLIENT_SECRET` | Same |
| `TOAST_RESTAURANT_GUID` | Same |

### Vendor Email Domains

Add one environment variable per vendor. No code changes ever needed to add a new vendor.

```bash
VENDOR_RESTAURANT_DEPOT=restaurantdepot.com
VENDOR_INSTACART=instacart.com
VENDOR_WEBSTAURANT=webstaurantstore.com
VENDOR_BARISTA_UNDERGROUND=baristaunderground.com
VENDOR_FRANCHISOR=youractualdomain.com      # replace with real domain
VENDOR_DESSERT_VENDOR=youractualdomain.com  # replace with real domain

# Adding a new vendor:
VENDOR_COFFEE_SUPPLIER=mycoffeesupplier.com  # just add a new line — restart server
```

---

## Google Sheets Templates

### Inventory Tab (tab name must be exactly: `Inventory`)

Create a Google Sheet and add these column headers in row 1 **exactly as shown** — do not change spelling or capitalization:

```
Item Name | Category | Unit | Par Level | Current Count | Unit Cost ($) | Supplier | Last Updated | Notes
```

**Category dropdown options:** Beans / Dairy / Syrups / Dry Goods / Packaging / Cleaning / Other

**Example rows:**
```
Ethiopia Yirgacheffe Beans | Beans     | lbs   | 10 | 7.5 | 12.50 | Barista Underground | 06/01/2025 | house blend base
Whole Milk                 | Dairy     | gallons | 8 | 5   | 4.99  | Restaurant Depot    | 06/01/2025 |
Oat Milk                   | Dairy     | gallons | 6 | 4   | 6.49  | Restaurant Depot    | 06/01/2025 |
Pistachio Syrup            | Syrups    | oz    | 64 | 32  | 0.25  | Webstaurant         | 06/01/2025 | per oz
Vanilla Syrup              | Syrups    | oz    | 48 | 40  | 0.20  | Webstaurant         | 06/01/2025 |
Caramel Syrup              | Syrups    | oz    | 32 | 28  | 0.22  | Webstaurant         | 06/01/2025 |
Hazelnut Syrup             | Syrups    | oz    | 24 | 18  | 0.22  | Webstaurant         | 06/01/2025 |
Cardamom                   | Dry Goods | oz    | 16 | 10  | 0.85  | Restaurant Depot    | 06/01/2025 | Yemeni bar
Adeni Tea Blend            | Dry Goods | oz    | 32 | 20  | 1.20  | Barista Underground | 06/01/2025 | custom blend
Qishr (coffee husk)        | Dry Goods | oz    | 16 | 12  | 0.95  | Barista Underground | 06/01/2025 |
Espresso Blend Beans       | Beans     | lbs   | 15 | 11  | 10.50 | Barista Underground | 06/01/2025 |
12oz Paper Cups            | Packaging | cases | 5  | 3   | 45.00 | Webstaurant         | 06/01/2025 |
16oz Paper Cups            | Packaging | cases | 5  | 4   | 48.00 | Webstaurant         | 06/01/2025 |
Cup Lids 12/16oz           | Packaging | cases | 5  | 4   | 38.00 | Webstaurant         | 06/01/2025 |
Heavy Cream                | Dairy     | gallons | 4 | 2  | 8.99  | Restaurant Depot    | 06/01/2025 |
Condensed Milk             | Dairy     | cans  | 24 | 16  | 1.25  | Restaurant Depot    | 06/01/2025 | Adeni Tea
Chocolate Sauce            | Syrups    | oz    | 24 | 18  | 0.30  | Webstaurant         | 06/01/2025 |
```

### Recipes Tab (tab name must be exactly: `Recipes`)

Add these headers in row 1:

```
Menu Item | Ingredient | Qty Per Serving | Unit | Notes
```

**Important:** Menu Item must match the item name in Toast **exactly**.
Ingredient must match the Item Name in the Inventory tab **exactly**.

**Complete recipe template for Shibam Coffee:**

```
Menu Item                      | Ingredient              | Qty Per Serving | Unit | Notes
Pistachio Latte (12oz)         | Pistachio Syrup         | 1.5             | oz   |
Pistachio Latte (12oz)         | Espresso Blend Beans    | 0.05            | lbs  | ~2 shots
Pistachio Latte (12oz)         | Whole Milk              | 8               | oz   | default milk
Pistachio Latte (16oz)         | Pistachio Syrup         | 2               | oz   |
Pistachio Latte (16oz)         | Espresso Blend Beans    | 0.05            | lbs  |
Pistachio Latte (16oz)         | Whole Milk              | 12              | oz   |
Shibam Latte (12oz)            | Cardamom                | 0.1             | oz   |
Shibam Latte (12oz)            | Espresso Blend Beans    | 0.05            | lbs  |
Shibam Latte (12oz)            | Whole Milk              | 8               | oz   |
Shibam Latte (16oz)            | Cardamom                | 0.15            | oz   |
Shibam Latte (16oz)            | Espresso Blend Beans    | 0.05            | lbs  |
Shibam Latte (16oz)            | Whole Milk              | 12              | oz   |
Adeni Tea                      | Adeni Tea Blend         | 0.3             | oz   |
Adeni Tea                      | Condensed Milk          | 1               | cans | 0.03 cans per serving
Adeni Tea                      | Whole Milk              | 4               | oz   |
Qishr                          | Qishr (coffee husk)     | 0.4             | oz   |
Haraz Coffee (12oz)            | Ethiopia Yirgacheffe Beans | 0.065        | lbs  |
Haraz Coffee (16oz)            | Ethiopia Yirgacheffe Beans | 0.065        | lbs  |
Latte (12oz)                   | Espresso Blend Beans    | 0.05            | lbs  |
Latte (12oz)                   | Whole Milk              | 8               | oz   |
Latte (16oz)                   | Espresso Blend Beans    | 0.05            | lbs  |
Latte (16oz)                   | Whole Milk              | 12              | oz   |
Cappuccino                     | Espresso Blend Beans    | 0.05            | lbs  |
Cappuccino                     | Whole Milk              | 5               | oz   |
Americano                      | Espresso Blend Beans    | 0.05            | lbs  |
Cortado                        | Espresso Blend Beans    | 0.05            | lbs  |
Cortado                        | Whole Milk              | 3               | oz   |
Vanilla Latte (12oz)           | Vanilla Syrup           | 1.5             | oz   |
Vanilla Latte (12oz)           | Espresso Blend Beans    | 0.05            | lbs  |
Vanilla Latte (12oz)           | Whole Milk              | 8               | oz   |
Caramel Latte (12oz)           | Caramel Syrup           | 1.5             | oz   |
Caramel Latte (12oz)           | Espresso Blend Beans    | 0.05            | lbs  |
Caramel Latte (12oz)           | Whole Milk              | 8               | oz   |
Hazelnut Latte (12oz)          | Hazelnut Syrup          | 1.5             | oz   |
Hazelnut Latte (12oz)          | Espresso Blend Beans    | 0.05            | lbs  |
Hazelnut Latte (12oz)          | Whole Milk              | 8               | oz   |
Mocha (12oz)                   | Chocolate Sauce         | 1               | oz   |
Mocha (12oz)                   | Espresso Blend Beans    | 0.05            | lbs  |
Mocha (12oz)                   | Whole Milk              | 8               | oz   |
Iced Latte (16oz)              | Espresso Blend Beans    | 0.05            | lbs  |
Iced Latte (16oz)              | Whole Milk              | 8               | oz   |
Iced Pistachio Latte (16oz)    | Pistachio Syrup         | 2               | oz   |
Iced Pistachio Latte (16oz)    | Espresso Blend Beans    | 0.05            | lbs  |
Iced Pistachio Latte (16oz)    | Whole Milk              | 8               | oz   |
Cold Brew (12oz)               | Ethiopia Yirgacheffe Beans | 0.1          | lbs  |
Oat Milk Latte (12oz)          | Oat Milk                | 8               | oz   |
Oat Milk Latte (12oz)          | Espresso Blend Beans    | 0.05            | lbs  |
Pistachio Oat Latte (12oz)     | Pistachio Syrup         | 1.5             | oz   |
Pistachio Oat Latte (12oz)     | Oat Milk                | 8               | oz   |
Pistachio Oat Latte (12oz)     | Espresso Blend Beans    | 0.05            | lbs  |
```

**Note:** Verify all quantities against your actual recipes and adjust them.
The values above are reasonable estimates — your actual portion sizes may differ.
The `inventory_vs_sales` tool will show variances if estimates are off.

### Invoice Ledger

The Ledger tab is **created automatically** by the `invoice_ledger_sync` tool.
You do not need to create it manually. If you create it manually, use these exact headers:

```
Date | Order # | Vendor | Item | Qty | Unit | Unit Cost | Line Total | Invoice Total | Parsed On
```

---

## Adding a New Vendor to the Invoice Parser

No code changes are needed. Simply add a new line to your `.env` file:

```bash
VENDOR_NEW_SUPPLIER=thenewsupplier.com
```

Then restart the server. The parser will automatically search for emails from `thenewsupplier.com`.

**Format:** `VENDOR_<UPPERCASE_NAME>=<email_domain_or_full_address>`
- Domain: `restaurantdepot.com` — matches any email from that domain
- Specific address: `orders@supplier.com` — matches only that exact address

---

## Deploy to Railway.app (Separate Project)

This deploys as a **second** Railway project, separate from `shibam-marketing-mcp`.

1. **Create second Railway project**
   - railway.app → New Project → Deploy from GitHub → select `wesai`
   - In Railway settings → Root Directory: `shibam-financial-mcp`

2. **Set environment variables**
   - Railway dashboard → your service → Variables → add all variables from `.env.example`
   - Toast variables must match the values in your marketing server exactly

3. **Get your second URL**
   - Railway → your service → Settings → Public URL
   - Example: `https://shibam-financial-mcp-production.up.railway.app`

4. **Add to Claude.ai**
   - Claude.ai → Settings → Feature Preview → Integrations → Add
   - Paste: `https://shibam-financial-mcp-production.up.railway.app/sse`
   - You should now have **two** integrations in Claude.ai — one for marketing, one for financial

5. **Verify**
   - Ask Claude: *"List all your tools"*
   - You should see tools from both servers (21 marketing + 29 financial = 50 total)

---

## Testing Each Tool

| Tool | Test command |
|------|-------------|
| QuickBooks P&L | `python scripts/test_tool.py --tool qb_pl_summary` |
| Vendor spend | `python scripts/test_tool.py --tool qb_vendor_spend --params '{"start_date":"2025-05-01","end_date":"2025-05-31"}'` |
| Parse invoices | `python scripts/test_tool.py --tool parse_vendor_invoices --params '{"start_date":"2025-05-01","end_date":"2025-05-31"}'` |
| Inventory | `python scripts/test_tool.py --tool inventory_current` |
| Reorder list | `python scripts/test_tool.py --tool inventory_reorder_list` |
| WhenIWork | `python scripts/test_tool.py --tool whenIwork_schedule --params '{"start_date":"2025-06-01","end_date":"2025-06-07"}'` |
| Weekly digest | `python scripts/test_tool.py --tool weekly_financial_digest` |
| Monthly close | `python scripts/test_tool.py --tool monthly_financial_close_checklist --params '{"month":"2025-05"}'` |

---

## How the Invoice Parser Works

1. Gmail API searches `yemenicoffeeco@gmail.com` for emails from configured vendor domains
2. For each matching email, retrieves all PDF and image attachments
3. For digital PDFs: extracts text with `pdfplumber` (fast, no API cost)
4. For scanned PDFs or images: sends to Claude API (`claude-opus-4-8`) for OCR + extraction
5. Claude returns structured JSON: vendor, order number, line items, totals
6. Results validated against `schemas/invoice_schema.json`
7. Data returned to you — or written to Google Sheets via `invoice_ledger_sync`

**If a parse fails:** The tool logs the email subject and date so you can find and manually review that invoice. It never fails silently.
