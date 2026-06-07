"""
One-time script to generate a QuickBooks OAuth refresh token.

Run once:
    python scripts/get_qb_token.py

Before running:
    1. Set QB_CLIENT_ID and QB_CLIENT_SECRET in .env
    2. In your Intuit Developer App settings, add http://localhost:8080/callback
       as an authorized redirect URI

Copy QB_REFRESH_TOKEN and QB_REALM_ID from the output into your .env file.
"""
import os
import sys
import json
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
import httpx
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("QB_CLIENT_ID")
CLIENT_SECRET = os.getenv("QB_CLIENT_SECRET")
ENVIRONMENT = os.getenv("QB_ENVIRONMENT", "production")

if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: Set QB_CLIENT_ID and QB_CLIENT_SECRET in .env first.")
    sys.exit(1)

AUTH_BASE = {
    "production": "https://appcenter.intuit.com/connect/oauth2",
    "sandbox": "https://appcenter.intuit.com/connect/oauth2",
}
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
REDIRECT_URI = "http://localhost:8080/callback"
SCOPES = "com.intuit.quickbooks.accounting com.intuit.quickbooks.payment"

auth_code = None
realm_id = None


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code, realm_id
        params = parse_qs(urlparse(self.path).query)
        auth_code = params.get("code", [None])[0]
        realm_id = params.get("realmId", [None])[0]
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"<html><body><h2>Authorization complete. You can close this tab.</h2></body></html>")

    def log_message(self, format, *args):
        pass  # Suppress HTTP server logs


auth_params = {
    "client_id": CLIENT_ID,
    "response_type": "code",
    "scope": SCOPES,
    "redirect_uri": REDIRECT_URI,
    "state": "shibam_qb_auth",
}
auth_url = f"{AUTH_BASE[ENVIRONMENT]}?{urlencode(auth_params)}"

print("Opening browser for QuickBooks OAuth consent...")
print("Sign in with the QuickBooks account that owns Shibam Coffee's QBO company.\n")
webbrowser.open(auth_url)

server = HTTPServer(("localhost", 8080), CallbackHandler)
server.handle_request()

if not auth_code:
    print("ERROR: Did not receive authorization code. Try again.")
    sys.exit(1)

r = httpx.post(
    TOKEN_URL,
    data={"grant_type": "authorization_code", "code": auth_code, "redirect_uri": REDIRECT_URI},
    auth=(CLIENT_ID, CLIENT_SECRET),
)
r.raise_for_status()
tokens = r.json()

print("\n" + "=" * 60)
print("SUCCESS — add these to your .env file:")
print("=" * 60)
print(f"QB_REFRESH_TOKEN={tokens['refresh_token']}")
print(f"QB_REALM_ID={realm_id}")
print("=" * 60)
print("\nThe refresh token auto-renews on each use.")
print("QB_REALM_ID is your QuickBooks company ID.")
