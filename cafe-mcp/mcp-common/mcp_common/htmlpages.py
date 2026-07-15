"""Shared HTML page shell + security headers for every public page the
server renders (public site, onboarding portal, tenant portal, OAuth login).

Security headers rationale:
- CSP self + 'unsafe-inline' for style: theme.css is a same-origin static
  file, but several pages (forms) still use inline style="" attributes for
  one-off layout — both need to stay allowed. No external origins anywhere.
- X-Frame-Options DENY: credential/consent pages must never be framed
- Referrer-Policy no-referrer: onboarding/session tokens travel in query
  strings and must never leak via the Referer header to external links
- nosniff + HSTS: standard hardening; TLS is terminated at the platform edge

Brand assets (theme.css, logo.svg, favicon.svg) live in CafeMCP.com/ at the
repo root and are mounted as static files by serverapp.py under
/CafeMCP.com/*. See CafeMCP.com/README.md for the palette.
"""
from __future__ import annotations

from starlette.responses import HTMLResponse

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self' https:",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store",
}

_BRAND_MARK = """<a href="/" class="brand-mark">
  <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="16" fill="#0F6E68"/>
    <path d="M18 26h22a6 6 0 0 1 6 6v2a6 6 0 0 1-6 6h-1.2A12 12 0 0 1 27 50H24a12 12 0 0 1-12-12V32a6 6 0 0 1 6-6z" fill="#F6EFE0"/>
    <path d="M40 30h2a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-2v-7z" fill="#F6EFE0"/>
    <circle cx="46" cy="17" r="4.5" fill="#C9A227"/>
  </svg>
  CafeMCP
</a>"""

_DEFAULT_NAV = f"""<div class="site-nav">
  {_BRAND_MARK}
  <div class="links">
    <a href="/#how-it-works">How it works</a>
    <a href="/login">Sign in</a>
  </div>
</div>"""


def page(title: str, body: str, status_code: int = 200, nav: str | None = None) -> HTMLResponse:
    """Render a full HTML page with the shared shell and security headers.

    `nav` overrides the default top nav (e.g. onboarding/portal pages that
    don't want a "Sign in" link shown to someone already mid-flow); pass
    "" to omit the nav entirely.
    """
    top_nav = _DEFAULT_NAV if nav is None else nav
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="icon" href="/CafeMCP.com/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/CafeMCP.com/theme.css">
</head>
<body>
{top_nav}
{body}
<footer><nav class="legal"><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/data-deletion">Data deletion</a></nav></footer>
</body></html>"""
    return HTMLResponse(html, status_code=status_code, headers=SECURITY_HEADERS)
