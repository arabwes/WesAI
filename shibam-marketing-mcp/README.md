# Shibam Coffee — Marketing MCP Server

This server connects Claude.ai to Shibam Coffee's live marketing data.
Once connected, you can ask Claude questions like:
- "How are my Google Ads performing this week?"
- "What's my Meta Ads CPM and is it on target?"
- "Give me a full weekly marketing digest"
- "Are any of my Instagram posts underperforming?"
- "Check my Google impression share"

---

## What This Server Does

| Data Source | Tools |
|------------|-------|
| Google Ads | Campaign performance, spend summary, KPI check (🟢🟡🔴), asset review, impression share |
| Meta Ads | Campaign performance, KPI check, objective breakdown, creative performance |
| Toast POS | Sales summary, top items, weekend/evening share, hourly heatmap, category breakdown |
| Google Business Profile | Review summary, profile completeness check, competitor listings |
| Instagram | Account summary, post performance, engagement rate |
| **Composite** | **Weekly marketing digest** (all KPIs in one report) |

Total: **21 tools**

Toast tools return a helpful setup message until you have API access. All other tools work immediately.

---

## Local Setup

### 1. Clone and install

```bash
cd shibam-marketing-mcp
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure environment

```bash
cp .env.example .env
# Open .env and fill in your credentials (see credential guide below)
```

### 3. Generate Google refresh token (one-time)

```bash
python scripts/get_refresh_token.py
# A browser window will open. Sign in with the Google account
# that owns your Google Ads account.
# Copy the GOOGLE_ADS_REFRESH_TOKEN it prints and paste it into .env
```

### 4. Start the server

```bash
python main.py
# Server starts on http://localhost:8000
```

### 5. Test the connection

```bash
curl http://localhost:8000/
# Should return: {"status":"ok","server":"shibam-marketing-mcp",...}
```

---

## How to Get Each Credential

### Google Ads

| Variable | Where to Get It |
|----------|----------------|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads UI → Tools & Settings → API Center → Apply for Basic access |
| `GOOGLE_ADS_CLIENT_ID` | console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client (Desktop app) |
| `GOOGLE_ADS_CLIENT_SECRET` | Same page as Client ID |
| `GOOGLE_ADS_REFRESH_TOKEN` | Run `python scripts/get_refresh_token.py` |
| `GOOGLE_ADS_CUSTOMER_ID` | Pre-filled: `3307041753` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Leave blank unless your account is under a Manager (MCC) account |

**Enable in Google Cloud Console:**
- Google Ads API
- Business Profile Performance API (for GBP tools)
- Places API (for competitor listings)

### Meta Ads

| Variable | Where to Get It |
|----------|----------------|
| `META_ACCESS_TOKEN` | **Best:** business.facebook.com → Business Settings → System Users → Generate Token (never expires) |
| `META_AD_ACCOUNT_ID` | Pre-filled: `act_817875271884127` |
| `META_APP_ID` | developers.facebook.com → Your App → Settings → Basic |
| `META_APP_SECRET` | Same page as App ID |

**System User token permissions needed:** `ads_read`, `ads_management`, `business_management`, `instagram_basic`, `instagram_manage_insights`

### Toast POS

Apply for API access at **developers.toasttab.com**. Set `TOAST_API_PENDING=true` until approved.

| Variable | Where to Get It |
|----------|----------------|
| `TOAST_CLIENT_ID` | developers.toasttab.com → Your App → Credentials (after approval) |
| `TOAST_CLIENT_SECRET` | Same page |
| `TOAST_RESTAURANT_GUID` | Provided by Toast on approval; also in your Toast Admin Portal URL |

### Google Business Profile + Places

| Variable | Where to Get It |
|----------|----------------|
| `GBP_ACCOUNT_ID` | After enabling Business Profile API, call `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` with your refresh token |
| `GBP_LOCATION_ID` | From the same accounts API response; look for your Alpharetta location |
| `GOOGLE_PLACES_API_KEY` | console.cloud.google.com → APIs & Services → Credentials → Create API Key → restrict to Places API |

### Instagram

| Variable | Where to Get It |
|----------|----------------|
| `INSTAGRAM_ACCESS_TOKEN` | Use the same System User token from Meta Ads (grant it `instagram_basic` + `instagram_manage_insights`) |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | Graph API Explorer → `GET /{facebook-page-id}?fields=instagram_business_account` |

---

## Deploy to Railway.app

1. **Push this repo to GitHub** (already in `arabwes/wesai`)

2. **Create Railway project**
   - railway.app → New Project → Deploy from GitHub → select `wesai`
   - In Railway settings → Root Directory: `shibam-marketing-mcp`

3. **Add environment variables**
   - Railway dashboard → your service → Variables tab
   - Add every variable from `.env.example` with your real values

4. **Get your URL**
   - Railway → your service → Settings → Networking → Public URL
   - Example: `https://shibam-marketing-mcp-production.up.railway.app`

5. **Connect to Claude.ai**
   - Claude.ai → Settings → Feature Preview → Integrations
   - Click **Add** → paste your URL + `/sse`
   - Example: `https://shibam-marketing-mcp-production.up.railway.app/sse`

6. **Verify**
   - In Claude.ai, ask: *"List all your tools"*
   - You should see all 21 Shibam marketing tools listed

---

## Testing Each Tool

After starting locally (`python main.py`), test tools by asking Claude at `http://localhost:8000/sse`:

| Tool | Test command in Claude |
|------|----------------------|
| Google Ads KPIs | "Check my Google Ads KPIs for the last 7 days" |
| Meta Ads KPIs | "Check my Meta Ads KPIs" |
| Toast Sales | "Show me Toast sales from June 1 to June 7" |
| Instagram | "What's my Instagram engagement rate?" |
| Competitor check | "Pull up my Google competitor listings" |
| Full digest | "Give me the weekly marketing digest" |

---

## Relationship to shibam-financial-mcp

This server handles **marketing and acquisition data** only.
`shibam-financial-mcp` (separate Railway deployment) handles financial,
payroll, inventory, and invoice data. Both servers can be connected to
Claude.ai simultaneously — add both SSE URLs as separate integrations.
