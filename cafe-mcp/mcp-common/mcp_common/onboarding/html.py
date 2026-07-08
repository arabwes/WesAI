"""HTML renderers for the onboarding portal. Pure functions: session state
in, HTMLResponse out (via the shared shell in mcp_common.htmlpages, which
applies the security headers). Saved secrets are NEVER echoed back — cards
only show a connected/not-connected status.
"""
from __future__ import annotations

import html as _html
import os

from mcp_common.htmlpages import page


def _esc(v) -> str:
    return _html.escape(str(v or ""), quote=True)


def _hidden(token: str, csrf: str) -> str:
    return (f'<input type="hidden" name="t" value="{_esc(token)}">'
            f'<input type="hidden" name="csrf" value="{_esc(csrf)}">')


def _status(connected: bool, label_ok="Connected", label_no="Not connected") -> str:
    return (f'<span class="ok">✓ {label_ok}</span>' if connected
            else f'<span class="warn">○ {label_no}</span>')


def dead_link_page():
    return page("Link not available", """
<h1>This link isn't available</h1>
<p>This onboarding link is invalid, has expired, or was already completed.</p>
<p>Please contact the person who sent it to you for a new link.</p>
""", status_code=404)


def error_page(message: str, back_href: str | None = None):
    back = f'<p><a href="{_esc(back_href)}">← Back</a></p>' if back_href else ""
    return page("Something went wrong", f"""
<h1>Something went wrong</h1>
<p class="error">{_esc(message)}</p>
{back}
""", status_code=400)


def dashboard(session, token: str, csrf: str, connected: set[str], settings: dict,
              notice: str | None = None):
    product = os.getenv("PRODUCT_NAME", "Cafe MCP")
    dash_href = f"/onboard?t={_esc(token)}"
    notice_html = f'<p class="ok">{_esc(notice)}</p>' if notice else ""

    google_enabled = bool(os.getenv("PLATFORM_GOOGLE_CLIENT_ID"))
    meta_enabled = bool(os.getenv("PLATFORM_META_APP_ID"))

    # ── Google card ───────────────────────────────────────────────────────
    if google_enabled:
        google_body = f"""
  <p>{_status('google' in connected)} — Gmail invoice tracking &amp; Google Sheets inventory.</p>
  <p><a href="/onboard/google/start?t={_esc(token)}&ads=0"><button type="button">Connect Google</button></a></p>
  <p style="margin-top:14px">{_status('google_ads' in connected, label_ok='Google Ads connected', label_no='Google Ads not connected')} — ad performance &amp; Business Profile reviews.</p>
  <p><a href="/onboard/google/start?t={_esc(token)}&ads=1"><button type="button">Connect Google Ads</button></a></p>
"""
    else:
        google_body = '<p class="hint">Google sign-in is not enabled on this deployment — your operator will configure Google access with you directly.</p>'

    # ── Meta card ─────────────────────────────────────────────────────────
    if meta_enabled:
        meta_body = f"""
  <p>{_status('meta' in connected)} — Facebook/Instagram ad and post performance.</p>
  <p><a href="/onboard/meta/start?t={_esc(token)}"><button type="button">Connect Facebook</button></a></p>
"""
    else:
        meta_body = '<p class="hint">Facebook sign-in is not enabled on this deployment — your operator will configure Meta access with you directly.</p>'

    vendor_lines = "\n".join(f"{k}: {v}" for k, v in (settings.get("vendor_domains") or {}).items())

    body = f"""
<h1>Connect {_esc(session.tenant_name)} to {_esc(product)}</h1>
<p class="hint">Connect the services your business uses. Skip anything that
doesn't apply — you can always come back to this page with the same link
until you finish. Nothing you enter is ever shown back on this page.</p>
{notice_html}

<div class="card"><h2 style="margin-top:0">Google (Gmail, Sheets, Ads, Business Profile)</h2>{google_body}</div>

<div class="card"><h2 style="margin-top:0">Facebook &amp; Instagram</h2>{meta_body}</div>

<div class="card">
  <h2 style="margin-top:0">Toast POS</h2>
  <p>{_status('toast' in connected)} — sales, labor, and staffing reports.</p>
  <p class="hint">From <a href="https://developers.toasttab.com" target="_blank" rel="noopener">developers.toasttab.com</a> → Your App → Credentials. Your Restaurant GUID appears in your Toast admin URL.</p>
  <form method="post" action="/onboard/toast">{_hidden(token, csrf)}
    <label>Client ID</label><input name="client_id" required autocomplete="off">
    <label>Client Secret</label><input name="client_secret" type="password" required autocomplete="off">
    <label>Restaurant GUID</label><input name="restaurant_guid" required autocomplete="off">
    <button type="submit">Save Toast</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">When I Work</h2>
  <p>{_status('wheniwork' in connected)} — staff scheduling reports.</p>
  <p class="hint">When I Work → Account Settings → API.</p>
  <form method="post" action="/onboard/wheniwork">{_hidden(token, csrf)}
    <label>API Key</label><input name="api_key" type="password" required autocomplete="off">
    <label>Account ID</label><input name="account_id" required autocomplete="off">
    <button type="submit">Save When I Work</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Business details</h2>
  <form method="post" action="/onboard/business">{_hidden(token, csrf)}
    <label>Business name</label>
    <input name="business_name" value="{_esc(settings.get('business_name'))}">
    <label>Invoice email address (the inbox that receives vendor invoices)</label>
    <input name="gmail_address" type="email" value="{_esc(settings.get('gmail_address'))}">
    <label>Inventory Google Sheet ID <span class="hint">(optional — from the sheet URL)</span></label>
    <input name="sheets_inventory_id" value="{_esc(settings.get('sheets_inventory_id'))}">
    <label>Ledger Google Sheet ID <span class="hint">(optional)</span></label>
    <input name="sheets_ledger_id" value="{_esc(settings.get('sheets_ledger_id'))}">
    <label>Vendors <span class="hint">(one per line, "Name: emaildomain.com" — used to find invoice emails)</span></label>
    <textarea name="vendor_domains" rows="4" style="width:100%;box-sizing:border-box;border:1px solid #999;border-radius:6px;padding:9px;background:inherit;color:inherit">{_esc(vendor_lines)}</textarea>
    <button type="submit" style="margin-top:10px">Save details</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Finish</h2>
  <p class="hint">When you've connected everything you use, finish setup to
  get your access key and instructions for your AI assistant. This link
  stops working afterwards.</p>
  <form method="post" action="/onboard/finish">{_hidden(token, csrf)}
    <button type="submit">Finish setup</button>
  </form>
</div>
"""
    return page(f"Set up {session.tenant_name}", body)


def finished(session, api_key: str, connector_url: str):
    product = os.getenv("PRODUCT_NAME", "Cafe MCP")
    body = f"""
<h1>You're all set 🎉</h1>
<p><strong>Save these now — the key is shown only once.</strong></p>

<div class="card">
  <h2 style="margin-top:0">Your connection details</h2>
  <label>Connector URL</label>
  <p><code>{_esc(connector_url)}</code></p>
  <label>Your access key</label>
  <p><code class="key">{_esc(api_key)}</code></p>
</div>

<div class="card">
  <h2 style="margin-top:0">Add to Claude</h2>
  <ol>
    <li>Claude.ai → Settings → Connectors → <em>Add custom connector</em></li>
    <li>Paste the Connector URL above and add</li>
    <li>When Claude opens a sign-in page, paste your access key</li>
    <li>Ask Claude something like <em>"How were my sales last week?"</em></li>
  </ol>
</div>

<div class="card">
  <h2 style="margin-top:0">Add to ChatGPT</h2>
  <ol>
    <li>ChatGPT → Settings → Connectors → create a custom connector</li>
    <li>URL: the Connector URL above</li>
    <li>Authentication: header <code>Authorization</code> = <code>Bearer &lt;your access key&gt;</code></li>
  </ol>
</div>

<p class="hint">Lost the key or need to connect more services later?
Contact the person who sent you the setup link — they can issue a new one
in seconds. Welcome to {_esc(product)}!</p>
"""
    return page("Setup complete", body)


def google_ads_picker(session, token: str, csrf: str, customer_ids: list[str]):
    options = "\n".join(
        f'<option value="{_esc(c)}">{_esc(c[:3])}-{_esc(c[3:6])}-{_esc(c[6:])}</option>'
        for c in customer_ids
    )
    return page("Choose your Google Ads account", f"""
<h1>Which Google Ads account?</h1>
<p class="hint">Your Google login has access to more than one Ads account —
pick the one for {_esc(session.tenant_name)}.</p>
<form method="post" action="/onboard/google/select">{_hidden(token, csrf)}
  <label>Google Ads account</label>
  <select name="customer_id" required>{options}</select>
  <button type="submit" style="margin-top:10px">Use this account</button>
</form>
""")


def meta_picker(session, token: str, csrf: str,
                ad_accounts: list[dict], ig_accounts: list[dict]):
    ad_options = "\n".join(
        f'<option value="{_esc(a["id"])}">{_esc(a.get("name") or a["id"])}</option>'
        for a in ad_accounts
    )
    ig_options = "\n".join(
        f'<option value="{_esc(a["id"])}">@{_esc(a.get("username") or a["id"])}</option>'
        for a in ig_accounts
    )
    ad_block = (f'<label>Ad account</label><select name="ad_account_id" required>{ad_options}</select>'
                if ad_accounts else
                '<p class="warn">No ad accounts found for this login — you can skip this.</p>'
                '<input type="hidden" name="ad_account_id" value="">')
    ig_block = (f'<label>Instagram business account</label><select name="ig_account_id">{ig_options}</select>'
                if ig_accounts else
                '<p class="warn">No Instagram business account found — connect your IG account '
                'to a Facebook Page you manage, or skip this.</p>'
                '<input type="hidden" name="ig_account_id" value="">')
    return page("Choose your accounts", f"""
<h1>Which accounts should we use?</h1>
<p class="hint">Pick the Facebook ad account and Instagram profile for {_esc(session.tenant_name)}.</p>
<form method="post" action="/onboard/meta/select">{_hidden(token, csrf)}
  {ad_block}
  {ig_block}
  <button type="submit" style="margin-top:10px">Save selection</button>
</form>
""")
