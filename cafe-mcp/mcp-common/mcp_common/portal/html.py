"""HTML renderers for the session-authenticated tenant portal (/portal).

Read-only status view + two actions (generate a fresh access key, manage
connections). "Manage connections" hands off to the already-tested
onboarding flow via a freshly minted, short-lived, single-use link rather
than duplicating the connect/save forms — see portal/routes.py.
"""
from __future__ import annotations

import html as _html
import os

from mcp_common.htmlpages import page


def _esc(v) -> str:
    return _html.escape(str(v or ""), quote=True)


def _status(connected: bool, label_ok="Connected", label_no="Not connected") -> str:
    return (f'<span class="ok">✓ {label_ok}</span>' if connected
            else f'<span class="warn">○ {label_no}</span>')


def _hidden_csrf(csrf: str) -> str:
    return f'<input type="hidden" name="csrf" value="{_esc(csrf)}">'


def signed_out_page():
    return page("Signed out — CafeMCP", """
<h1>Signed out</h1>
<p>You've been signed out. <a href="/login">Sign in again</a></p>
""")


def dashboard(session, csrf: str, connected: set[str], settings: dict, notice: str | None = None):
    product = os.getenv("PRODUCT_NAME", "CafeMCP")
    notice_html = f'<p class="ok">{_esc(notice)}</p>' if notice else ""

    rows = [
        ("Toast POS", "toast", "sales, labor, and staffing reports"),
        ("Google (Gmail &amp; Sheets)", "google", "invoice tracking and inventory"),
        ("Google Ads", "google_ads", "ad performance and Business Profile"),
        ("Facebook &amp; Instagram", "meta", "ad and post performance"),
        ("When I Work", "wheniwork", "staff scheduling"),
    ]
    status_rows = "\n".join(
        f'<div class="card" style="display:flex;justify-content:space-between;align-items:center;">'
        f'<div><strong>{label}</strong><p class="hint" style="margin:2px 0 0">{desc}</p></div>'
        f'<div>{_status(key in connected)}</div></div>'
        for label, key, desc in rows
    )

    business_name = settings.get("business_name") or session.tenant_name

    body = f"""
<h1>{_esc(business_name)}</h1>
<p class="hint">Signed in as {_esc(session.email or "your account")}.</p>
{notice_html}

<h2>Your connections</h2>
{status_rows}

<div class="card">
  <h2 style="margin-top:0">Manage connections</h2>
  <p class="hint">Connect a new service, reconnect one that's expired, or
  update your business details.</p>
  <form method="post" action="/portal/manage">{_hidden_csrf(csrf)}
    <button type="submit">Manage connections</button>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Access key</h2>
  <p class="hint">Only needed for AI assistants that require a manual key
  (e.g. ChatGPT custom connectors) instead of signing in with Google/Facebook.
  Generating a new key does not affect Claude or any assistant using
  sign-in — those never need a key.</p>
  <form method="post" action="/portal/generate-key">{_hidden_csrf(csrf)}
    <input type="text" name="label" placeholder="Label (e.g. \\"ChatGPT\\")" maxlength="100">
    <button type="submit" class="btn-secondary">Generate new access key</button>
  </form>
</div>

<div class="card">
  <form method="post" action="/portal/logout">{_hidden_csrf(csrf)}
    <button type="submit" class="btn-secondary">Sign out</button>
  </form>
</div>
"""
    return page(f"{business_name} — {product}", body)


def key_generated(session, api_key: str, connector_url: str):
    body = f"""
<h1>New access key</h1>
<p><strong>Save this now — it's shown only once.</strong> Older keys keep
working until revoked; this doesn't replace them.</p>

<div class="card">
  <label>Connector URL</label>
  <p><code>{_esc(connector_url)}</code></p>
  <label>Access key</label>
  <p><code class="key">{_esc(api_key)}</code></p>
</div>

<div class="card">
  <h2 style="margin-top:0">For ChatGPT (custom connector)</h2>
  <ol>
    <li>Settings → Connectors → create a custom connector</li>
    <li>URL: the Connector URL above</li>
    <li>Authentication: header <code>Authorization</code> = <code>Bearer &lt;your access key&gt;</code></li>
  </ol>
</div>

<p><a href="/portal">← Back to portal</a></p>
"""
    return page("New access key — CafeMCP", body)
