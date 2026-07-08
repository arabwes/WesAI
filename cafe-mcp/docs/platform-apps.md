# Platform OAuth Apps — one-time operator setup

The self-service onboarding portal lets customers connect accounts by
logging in, which requires YOU (the operator) to own one Google Cloud OAuth
app and one Meta app that all customers consent through. This is the
standard SaaS pattern; it comes with platform verification obligations
documented below.

## 0. Custom domain (do this first)

Google brand verification requires an authorized domain **you own** —
`*.up.railway.app` subdomains won't pass domain ownership checks.

1. Buy a domain (~$10/yr, e.g. `cafemcp.app`) at any registrar.
2. Railway → your service → Settings → Networking → **Custom Domain** → add
   it and create the CNAME record the dialog shows at your registrar.
3. Set `OAUTH_PUBLIC_URL=https://<your-domain>` on the service and redeploy.
4. Verify domain ownership in [Google Search Console](https://search.google.com/search-console)
   (URL-prefix property → HTML-tag or DNS method).
5. From here on, use the custom domain in every URL below (homepage,
   privacy, redirect URIs).

The server already hosts the required public pages:
`https://<domain>/` (homepage), `/privacy`, `/terms`, `/data-deletion`.
Set `PRODUCT_NAME` and `OPERATOR_EMAIL` env vars so they display correctly.

## 1. Google Cloud (Gmail, Sheets, Google Ads, GBP)

1. [console.cloud.google.com](https://console.cloud.google.com) → New
   Project (e.g. "Cafe MCP").
2. **APIs & Services → Library** — enable: Gmail API, Google Sheets API,
   Google Ads API, Business Profile API (and "My Business Account
   Management API" for GBP discovery).
3. **OAuth consent screen** → External:
   - App name, support email, logo.
   - Homepage: `https://<domain>/` · Privacy policy: `https://<domain>/privacy`
     · Terms: `https://<domain>/terms`.
   - Authorized domain: `<domain>` (must be Search-Console-verified, step 0.4).
4. **Scopes**: add
   - `.../auth/gmail.readonly` (**restricted** scope — see verification notes)
   - `.../auth/spreadsheets` (sensitive)
   - `.../auth/adwords` (sensitive)
   - `.../auth/business.manage` (sensitive)
5. **Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<domain>/onboard/google/callback`
   - Copy the client ID/secret → Railway env vars
     `PLATFORM_GOOGLE_CLIENT_ID` / `PLATFORM_GOOGLE_CLIENT_SECRET`.
6. **Google Ads developer token**: ads.google.com (a manager account) →
   Tools & Settings → API Center → apply. Token →
   `PLATFORM_GOOGLE_ADS_DEVELOPER_TOKEN`. Basic access is fine to start;
   apply for **Standard access** before serving many customers.

### Google verification path (compliance)

- While the consent screen is in **Testing** mode: each customer's Google
  account must be added under "Test users", AND their refresh tokens
  expire every 7 days. Usable for pilots only.
- **Submit for verification** (Publishing status → In production →
  verification flow): requires the homepage/privacy URLs above, a demo
  video of the consent flow, and per-scope justifications.
- `gmail.readonly` is a **restricted** scope: expect stricter review and,
  at scale, an annual CASA security assessment. Mitigation already built
  into the portal: Gmail is a separate optional connect — customers who
  skip invoice parsing never touch the restricted scope, and you can defer
  requesting it until you have volume that justifies the assessment.
- The privacy policy at `/privacy` includes the required Google API
  Services User Data Policy **Limited Use** disclosure — keep it accurate
  if you change what the product does with Gmail data.

## 2. Meta (Facebook Ads + Instagram)

1. [developers.facebook.com](https://developers.facebook.com) → My Apps →
   Create App → type **Business** (e.g. "Cafe MCP").
2. **Settings → Basic**:
   - App icon, category (Business and pages).
   - Privacy policy URL: `https://<domain>/privacy`
   - **Data deletion instructions URL**: `https://<domain>/data-deletion`
     (required — the server hosts this page).
   - Copy App ID / App Secret → `PLATFORM_META_APP_ID` /
     `PLATFORM_META_APP_SECRET`.
3. **Add products**:
   - **Facebook Login** (Web) → Settings → Valid OAuth Redirect URIs:
     `https://<domain>/onboard/meta/callback`
   - **Marketing API**.
4. **Business verification** (Settings → Business verification): submit
   your legal business details/documents. Prerequisite for Advanced Access.
5. **App Review** → request **Advanced Access** for: `ads_read`,
   `business_management`, `instagram_basic`, `instagram_manage_insights`,
   `pages_show_list`. Provide a screencast of the onboarding portal flow
   and explain each permission's use (reading the customer's own ad
   metrics / IG insights to generate their reports).

### Meta review path (compliance)

- Until App Review approves those permissions, the app is in **dev mode**:
  only people listed under App Roles (Admins/Developers/**Testers**) can
  complete the consent flow. Interim path for pilot customers: add them as
  Testers.
- Long-lived user tokens expire after ~60 days with no silent refresh. The
  portal stores the issue date; when a customer's Meta connection ages
  out, re-issue an onboarding link so they can reconnect (one click).
- The System-User-token form fallback remains available for customers with
  their own Meta Business Manager setup.

## 3. Ongoing platform obligations checklist

- [ ] Keep `/privacy` accurate whenever data usage changes (both platforms
      audit this).
- [ ] Respond to data-deletion requests within 30 days (offboarding
      cascade: `DELETE FROM tenants WHERE slug=...`).
- [ ] Google: complete verification before exceeding the 100-user
      unverified cap; renew CASA annually if using restricted scopes at scale.
- [ ] Meta: complete Business Verification + App Review before onboarding
      customers you can't add as Testers.
- [ ] Rotate `TENANT_MASTER_KEY` and platform app secrets on any suspected
      exposure (see docs/runbook.md).
