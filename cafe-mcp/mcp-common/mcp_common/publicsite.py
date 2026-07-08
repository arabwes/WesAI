"""Public product pages required for Google OAuth verification and Meta App
Review: homepage, privacy policy, terms, and data-deletion instructions.

Content is operator-configurable via env vars (PRODUCT_NAME, OPERATOR_EMAIL)
so the pages stay accurate without code edits. These routes are
unauthenticated by design — they must be reachable by platform reviewers.
"""
from __future__ import annotations

import os

from mcp_common.htmlpages import page

PUBLIC_PAGE_PATHS = {"/", "/health", "/privacy", "/terms", "/data-deletion"}


def _product() -> str:
    return os.getenv("PRODUCT_NAME", "Cafe MCP")


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
        return page(p, f"""
<nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/data-deletion">Data deletion</a></nav>
<h1>{p}</h1>
<p>{p} is a business analytics assistant service for small businesses
(cafés, restaurants, and retail). It connects a business owner's own
operational accounts to an AI assistant of their choice (such as Claude or
ChatGPT), so the owner can ask questions about their own sales, labor,
marketing, and inventory data in plain English.</p>

<h2>What it connects to</h2>
<p>Each business connects only the services it uses, and only its own
accounts:</p>
<ul>
  <li><strong>Toast POS</strong> — sales, labor, and employee reports</li>
  <li><strong>Gmail</strong> (read-only) — locating vendor invoice emails for spend tracking</li>
  <li><strong>Google Sheets</strong> — the business's own inventory and ledger spreadsheets</li>
  <li><strong>Google Ads &amp; Google Business Profile</strong> — the business's own ad performance and listing reviews</li>
  <li><strong>Meta Ads &amp; Instagram</strong> — the business's own ad and post performance</li>
  <li><strong>When I Work</strong> — staff scheduling reports</li>
</ul>

<h2>How access works</h2>
<p>Each business authorizes access to its own accounts through the
providers' standard consent screens. Credentials are stored encrypted and
are only ever used to answer that business's own questions — see the
<a href="/privacy">privacy policy</a>.</p>

<h2>Contact</h2>
<p>Operated by {_contact()}. Access is by invitation.</p>
""")

    @mcp.custom_route("/privacy", methods=["GET"])
    async def privacy(request):
        p = _product()
        return page(f"Privacy Policy — {p}", f"""
<nav><a href="/">Home</a></nav>
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
  <li>Every data access is written to an audit log (tenant, tool, time, outcome) with secrets redacted.</li>
  <li>Access requires per-Tenant API keys (stored as salted hashes only); each Tenant's data is isolated from every other Tenant's.</li>
  <li>Encrypted database backups are retained for 90 days.</li>
</ul>

<h2>Sharing</h2>
<p>We do not sell or share Tenant data. Subprocessors: Railway (hosting,
database) and the AI assistant provider the Tenant itself chooses to
connect (e.g. Anthropic or OpenAI), which receives only the report text the
Tenant requests in its own conversations.</p>

<h2>Retention and deletion</h2>
<p>Stored credentials and settings are retained until the Tenant is
offboarded. Offboarding deletes the Tenant's credentials, API keys, and
settings permanently (database cascade). To request deletion, see
<a href="/data-deletion">data deletion</a>. Tenants can also revoke the
Service's access at any time from their Google or Facebook security
settings, which invalidates the stored tokens immediately.</p>

<h2>Breach notification &amp; contact</h2>
<p>In the event of a security incident affecting Tenant data we will notify
affected Tenants without undue delay. Privacy questions and requests:
{_contact()}.</p>
""")

    @mcp.custom_route("/terms", methods=["GET"])
    async def terms(request):
        p = _product()
        return page(f"Terms of Service — {p}", f"""
<nav><a href="/">Home</a></nav>
<h1>Terms of Service</h1>
<p class="hint">Last updated: July 2026</p>
<ol>
  <li><strong>Service.</strong> {p} connects a Tenant's own business accounts to the Tenant's chosen AI assistant to produce reports about the Tenant's own data. Access is by invitation from the operator.</li>
  <li><strong>Authorization.</strong> The Tenant represents that it is authorized to connect each account it connects, and grants the Service permission to access those accounts solely to provide the features described on the <a href="/">homepage</a>.</li>
  <li><strong>Credentials.</strong> The Tenant is responsible for keeping its {p} API key confidential. Keys can be revoked and reissued at any time by contacting the operator.</li>
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
<nav><a href="/">Home</a></nav>
<h1>Data Deletion Instructions</h1>
<p>You can remove {p}'s access to your data and have all stored information
deleted at any time, using either or both of the following:</p>

<h2>1. Revoke access from the provider (immediate)</h2>
<ul>
  <li><strong>Google</strong>: <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> → find {p} → Remove access. This invalidates our stored tokens instantly.</li>
  <li><strong>Facebook/Instagram</strong>: Settings &amp; privacy → Settings → Business integrations (or Apps and Websites) → find {p} → Remove. This invalidates our stored tokens instantly.</li>
</ul>

<h2>2. Request full deletion from the Service</h2>
<p>Email {_contact()} from the address associated with your business
requesting deletion. We will offboard your tenant, which permanently
deletes all stored credentials, API keys, settings, and audit history for
your business (database cascade), and confirm completion. Requests are
honored within 30 days; typically much sooner.</p>

<p class="hint">Note: the Service does not warehouse your business data —
reports are generated on demand from your connected accounts — so deletion
concerns stored credentials and configuration.</p>
""")
