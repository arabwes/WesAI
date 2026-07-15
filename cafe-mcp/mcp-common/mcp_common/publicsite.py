"""Public product pages: marketing homepage plus the compliance pages
required for Google OAuth verification and Meta App Review (privacy,
terms, data-deletion instructions).

Content is operator-configurable via env vars (PRODUCT_NAME, OPERATOR_EMAIL)
so the pages stay accurate without code edits. These routes are
unauthenticated by design — they must be reachable by platform reviewers
and prospective customers alike.
"""
from __future__ import annotations

import os

from mcp_common.htmlpages import page

PUBLIC_PAGE_PATHS = {"/", "/health", "/privacy", "/terms", "/data-deletion"}


def _product() -> str:
    return os.getenv("PRODUCT_NAME", "CafeMCP")


def _contact() -> str:
    return os.getenv("OPERATOR_EMAIL", "the operator")


def register_public_pages(mcp) -> None:
    from starlette.responses import JSONResponse

    @mcp.custom_route("/health", methods=["GET"])
    async def health(request):
        """Railway healthcheck target. Deliberately minimal."""
        return JSONResponse({"status": "ok"})

    @mcp.custom_route("/", methods=["GET"])
    async def homepage(request):
        p = _product()
        contact = _contact()
        mailto = f"mailto:{contact}?subject=Request%20access%20to%20{p}" if "@" in contact else "#contact"
        return page(p, f"""
<div class="hero">
  <span class="eyebrow">AI-native business analytics</span>
  <h1>Ask your business a question. Get a real answer.</h1>
  <p class="lede">{p} connects your café or restaurant's own Toast, Google,
  Meta, and scheduling accounts to the AI assistant you already use —
  Claude or ChatGPT — so you can ask about sales, labor, marketing, and
  inventory in plain English instead of digging through five dashboards.</p>
  <div class="cta-row">
    <a class="btn" href="/login">Sign in</a>
    <a class="btn btn-secondary" href="{mailto}">Request access</a>
  </div>
</div>

<h2 id="how-it-works">How it works</h2>
<ol class="steps">
  <li><strong>Connect your accounts.</strong> Sign in with Google and/or
  Facebook and authorize {p} to read your own Toast, ad, and scheduling
  data — nothing is shared with anyone else.</li>
  <li><strong>Add it to your AI assistant.</strong> Point Claude or ChatGPT
  at your {p} connector — no passwords or API keys to copy around.</li>
  <li><strong>Ask questions in plain English.</strong> "How was labor cost
  vs. revenue last week?" "Which ad set is actually converting?" Your
  assistant pulls live answers from your connected accounts.</li>
</ol>

<h2>What it connects to</h2>
<div class="feature-grid">
  <div class="card"><div class="icon">☕</div><strong>Toast POS</strong>
    <p class="hint">Sales, labor, and employee reports.</p></div>
  <div class="card"><div class="icon">📧</div><strong>Gmail &amp; Sheets</strong>
    <p class="hint">Vendor invoice tracking and inventory spreadsheets.</p></div>
  <div class="card"><div class="icon">📈</div><strong>Google Ads &amp; Business Profile</strong>
    <p class="hint">Ad performance and listing reviews.</p></div>
  <div class="card"><div class="icon">📣</div><strong>Meta Ads &amp; Instagram</strong>
    <p class="hint">Ad and post performance.</p></div>
  <div class="card"><div class="icon">🗓️</div><strong>When I Work</strong>
    <p class="hint">Staff scheduling reports.</p></div>
</div>

<h2>Built for your data, not ours</h2>
<p>Every business's credentials are encrypted at rest and fully isolated
from every other business on {p}. Access is logged and auditable. You can
disconnect any service, or your whole account, at any time — see the
<a href="/privacy">privacy policy</a> and <a href="/data-deletion">data
deletion</a> page for specifics.</p>

<h2>Get started</h2>
<p>{p} is invite-based today. If your business already has an account,
<a href="/login">sign in</a> to manage your connections. Otherwise, reach
out to {contact} to request access.</p>
""")

    @mcp.custom_route("/privacy", methods=["GET"])
    async def privacy(request):
        p = _product()
        return page(f"Privacy Policy — {p}", f"""
<h1>Privacy Policy</h1>
<p class="hint">Last updated: July 2026</p>

<h2>Who we are</h2>
<p>{p} ("the Service") is a business analytics connector service operated by
{_contact()}. The Service acts on behalf of each subscribing business
("Tenant") to retrieve that Tenant's own data from services the Tenant has
explicitly connected.</p>

<h2>What data we access and why</h2>
<ul>
  <li><strong>Toast POS</strong>: sales, orders, labor, and employee records — to produce financial and staffing reports for the Tenant.</li>
  <li><strong>Gmail (read-only)</strong>: the Tenant searches its own mailbox for vendor invoice emails; message content is parsed to extract invoice amounts and vendor names for the Tenant's spend reports. We do not read unrelated email, and Gmail content is processed transiently — it is not stored by the Service.</li>
  <li><strong>Google Sheets</strong>: reads (and, where the Tenant enables it, writes) the Tenant's own inventory/ledger spreadsheets.</li>
  <li><strong>Google Ads / Google Business Profile</strong>: the Tenant's own campaign metrics and business listing reviews.</li>
  <li><strong>Meta Ads / Instagram</strong>: the Tenant's own ad campaign and post performance metrics.</li>
  <li><strong>When I Work</strong>: the Tenant's own staff schedules.</li>
  <li><strong>Google/Facebook sign-in</strong>: when you sign in to the {p} portal, we request only your basic profile and email address (Google: <code>openid email profile</code>; Facebook: <code>public_profile email</code>) to identify your account — this is separate from, and does not grant, the data-access scopes above.</li>
</ul>

<h2>Limited Use — Google user data</h2>
<p>{p}'s use and transfer of information received from Google APIs adheres
to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google
API Services User Data Policy</a>, including the Limited Use requirements.
Specifically: Google user data is used <em>only</em> to provide the
connected Tenant's own analytics features described above. It is never used
for advertising, never sold, never used to train machine-learning models,
and never transferred to third parties except as necessary to provide those
features to the Tenant, to comply with law, or as part of a merger with
notice.</p>

<h2>How data is stored and protected</h2>
<ul>
  <li>Access credentials (OAuth refresh tokens, API keys) are encrypted at rest (Fernet/AES) with an operator-held master key, in a managed PostgreSQL database.</li>
  <li>All traffic is TLS-encrypted in transit.</li>
  <li>Report data retrieved from connected services is processed transiently to answer the Tenant's requests and is not warehoused by the Service.</li>
  <li>Every data access and portal sign-in is written to an audit log (tenant, action, time, outcome) with secrets redacted.</li>
  <li>Sign-in uses your Google/Facebook identity — we never ask for or store a password. Access keys (for AI assistants that require one) are stored as salted hashes only, never in plain text.</li>
  <li>Each Tenant's data is fully isolated from every other Tenant's.</li>
  <li>Encrypted database backups are retained for 90 days.</li>
</ul>

<h2>Sharing</h2>
<p>We do not sell or share Tenant data. Subprocessors: Railway (hosting,
database) and the AI assistant provider the Tenant itself chooses to
connect (e.g. Anthropic or OpenAI), which receives only the report text the
Tenant requests in its own conversations.</p>

<h2>Retention and deletion</h2>
<p>Stored credentials and settings are retained until the Tenant is
offboarded. Offboarding deletes the Tenant's credentials, access keys,
linked sign-in identities, and settings permanently (database cascade). To
request deletion, see <a href="/data-deletion">data deletion</a>. Tenants
can also revoke the Service's access at any time from their Google or
Facebook security settings, which invalidates the stored tokens
immediately.</p>

<h2>Breach notification &amp; contact</h2>
<p>In the event of a security incident affecting Tenant data we will notify
affected Tenants without undue delay. Privacy questions and requests:
{_contact()}.</p>
""")

    @mcp.custom_route("/terms", methods=["GET"])
    async def terms(request):
        p = _product()
        return page(f"Terms of Service — {p}", f"""
<h1>Terms of Service</h1>
<p class="hint">Last updated: July 2026</p>
<ol>
  <li><strong>Service.</strong> {p} connects a Tenant's own business accounts to the Tenant's chosen AI assistant to produce reports about the Tenant's own data. Access is by invitation from the operator.</li>
  <li><strong>Authorization.</strong> The Tenant represents that it is authorized to connect each account it connects, and grants the Service permission to access those accounts solely to provide the features described on the <a href="/">homepage</a>.</li>
  <li><strong>Sign-in.</strong> Tenants sign in to {p} using their Google or Facebook identity. The Tenant is responsible for the security of that account. Access keys issued for AI-assistant connections that require one should be kept confidential and can be revoked and reissued at any time from the portal.</li>
  <li><strong>Acceptable use.</strong> No attempts to access another tenant's data, probe, or disrupt the Service.</li>
  <li><strong>Data.</strong> Handled per the <a href="/privacy">Privacy Policy</a>. Third-party services remain governed by their own terms.</li>
  <li><strong>Warranty & liability.</strong> The Service is provided "as is" without warranties; reports are informational and not financial or legal advice. Liability is limited to the maximum extent permitted by law.</li>
  <li><strong>Changes & termination.</strong> Either party may terminate at any time; on termination the Tenant is offboarded and stored credentials are deleted. Material changes to these terms will be communicated to Tenants.</li>
  <li><strong>Contact.</strong> {_contact()}.</li>
</ol>
""")

    @mcp.custom_route("/data-deletion", methods=["GET"])
    async def data_deletion(request):
        p = _product()
        return page(f"Data Deletion — {p}", f"""
<h1>Data Deletion Instructions</h1>
<p>You can remove {p}'s access to your data and have all stored information
deleted at any time, using either or both of the following:</p>

<h2>1. Revoke access from the provider (immediate)</h2>
<ul>
  <li><strong>Google</strong>: <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> → find {p} → Remove access. This invalidates our stored tokens instantly, including sign-in.</li>
  <li><strong>Facebook/Instagram</strong>: Settings &amp; privacy → Settings → Business integrations (or Apps and Websites) → find {p} → Remove. This invalidates our stored tokens instantly, including sign-in.</li>
</ul>

<h2>2. Request full deletion from the Service</h2>
<p>Email {_contact()} from the address associated with your business
requesting deletion. We will offboard your tenant, which permanently
deletes all stored credentials, access keys, linked sign-in identities,
settings, and audit history for your business (database cascade), and
confirm completion. Requests are honored within 30 days; typically much
sooner.</p>

<p class="hint">Note: the Service does not warehouse your business data —
reports are generated on demand from your connected accounts — so deletion
concerns stored credentials and configuration.</p>
""")
