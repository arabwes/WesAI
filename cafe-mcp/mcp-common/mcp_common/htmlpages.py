"""Shared HTML page shell + security headers for every public page the
server renders (public site, onboarding portal, OAuth login).

Security headers rationale:
- CSP self-only (inline styles allowed — pages use one embedded <style>)
- X-Frame-Options DENY: credential/consent pages must never be framed
- Referrer-Policy no-referrer: onboarding tokens travel in query strings
  and must never leak via the Referer header to external links
- nosniff + HSTS: standard hardening; TLS is terminated at the platform edge
"""
from __future__ import annotations

from starlette.responses import HTMLResponse

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https:",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store",
}

_STYLE = """
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", sans-serif; max-width: 720px;
         margin: 48px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #141414; } }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 2em; }
  a { color: #2563eb; }
  nav { margin-bottom: 2.5em; font-size: 0.9rem; }
  nav a { margin-right: 1.2em; color: inherit; opacity: 0.7; text-decoration: none; }
  input, select { width: 100%; padding: 9px; font-size: 1rem; box-sizing: border-box;
          margin: 4px 0 14px; border: 1px solid #999; border-radius: 6px; background: inherit; color: inherit; }
  label { font-size: 0.9rem; font-weight: 600; }
  button { padding: 10px 18px; font-size: 1rem; background: #1a1a1a; color: #fff;
           border: none; border-radius: 6px; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { background: #e8e8e8; color: #141414; } }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 16px 20px; margin: 14px 0; }
  .ok { color: #16a34a; font-weight: 600; } .warn { color: #d97706; } .error { color: #dc2626; }
  .hint { opacity: 0.65; font-size: 0.88rem; }
  code, .key { font-family: ui-monospace, monospace; background: #8882; padding: 2px 6px;
               border-radius: 4px; word-break: break-all; }
  footer { margin-top: 4em; font-size: 0.8rem; opacity: 0.6; }
"""


def page(title: str, body: str, status_code: int = 200) -> HTMLResponse:
    """Render a full HTML page with the shared shell and security headers."""
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><style>{_STYLE}</style></head>
<body>
{body}
<footer><a href="/">Home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></footer>
</body></html>"""
    return HTMLResponse(html, status_code=status_code, headers=SECURITY_HEADERS)
