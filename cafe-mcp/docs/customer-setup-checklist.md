# What we need from you to connect your business

Send this to each new customer/business owner. Everything they gather here
gets entered once by you via `scripts/tenant_admin.py` — they don't need to
run any commands or touch code themselves.

Only fill in the sections for the services you actually use — every
section is optional, and skipped ones just mean those tools return a
friendly "not set up yet" message instead of failing.

## 1. Toast POS (sales, labor, employees)

- Log in at **developers.toasttab.com** → Create App (or use an existing
  one) → note the **Client ID** and **Client Secret**.
- Your **Restaurant GUID** — visible in your Toast Admin Portal URL, or
  provided by Toast when API access is approved.
- Confirm whether your Toast API access is **Production approved** (not
  just Sandbox) for the Orders and Labor APIs specifically.

Send us: Client ID, Client Secret, Restaurant GUID, environment
(production/sandbox).

## 2. Gmail + Google Sheets (vendor invoices, inventory)

- We'll send you a one-time OAuth consent link (or walk you through running
  `scripts/get_google_token.py` yourself if you're comfortable with a
  terminal) — you sign in with the Google account that receives vendor
  invoice emails, and it prints a refresh token for us to store.
- The Google Sheet IDs (from the sheet's URL) for your inventory tracker
  and/or vendor ledger, if you have one already — otherwise we can help set
  one up.

Send us: the refresh token from the consent flow, and any existing Sheet
IDs.

## 3. QuickBooks (payroll, accounting) — currently disabled fleet-wide

Not available yet on this deployment; skip this section.

## 4. When I Work (scheduling)

- Your When I Work **API key** and **Account ID** — found in When I Work's
  account settings under Integrations/API access.

## 5. Google Ads

- A Google Ads **Developer Token** (from your Google Ads manager account,
  or apply for one — Basic access is fine to start).
- OAuth Client ID/Secret + refresh token (same consent-flow process as
  Gmail, but requesting Ads access instead).
- Your **Google Ads Customer ID** (the 10-digit number, no dashes).

## 6. Meta Ads (Facebook/Instagram ads)

- A Meta **App ID** and **App Secret** (developers.facebook.com → your app
  → Settings → Basic).
- An access token — ideally a **System User Token** (never expires) from
  Business Settings → System Users, with `ads_read`, `ads_management`,
  `business_management` permissions. If your app isn't approved yet, a
  long-lived **User Token** works too (expires every 60 days, needs manual
  renewal) — see the note on generating one below.
- Your **Ad Account ID** (the `act_...` number).

## 7. Instagram

- Usually the same access token as Meta Ads above, just also granted
  `instagram_basic` + `instagram_manage_insights` permissions.
- Your **Instagram Business Account ID** (not your username) — we can look
  this up together via the Graph API if you're not sure.

## 8. Google Business Profile

- A Google Places API key (we can generate this together in Google Cloud
  Console — takes 2 minutes).
- Your GBP Account ID and Location ID (found via a one-time API lookup
  once you've done the Google OAuth consent above).

## 9. General business info (used to personalize reports, all optional)

- Business name
- Any KPI targets you want tracked differently from the defaults (ad spend
  budget range, target CPC/CTR, labor % target, etc.)
- Top-selling menu items you want specifically flagged in reports
- Vendor names + email domains for invoice matching (e.g. "Sysco" →
  `sysco.com`)

---

Once we have what's checked above, you'll get:
1. A **connector URL** to add to Claude or ChatGPT.
2. A **personal API key** — keep this private, it's how the assistant
   accesses your business's data specifically (never anyone else's).
