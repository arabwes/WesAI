"""
One-time script to generate a Google OAuth refresh token for Google Ads and GBP.

Run this once locally:
    python scripts/get_refresh_token.py

Before running:
    1. Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in your .env file
    2. Ensure your Google Cloud OAuth app has these redirect URIs:
       - http://localhost:8080
       - http://localhost:8080/

The script will open a browser window. Sign in with the Google account
that has access to your Google Ads account. Copy the refresh_token from
the output and add it to your .env as GOOGLE_ADS_REFRESH_TOKEN.
"""
import os
import sys

from google_auth_oauthlib.flow import InstalledAppFlow
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("GOOGLE_ADS_CLIENT_ID")
CLIENT_SECRET = os.getenv("GOOGLE_ADS_CLIENT_SECRET")

if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env first.")
    sys.exit(1)

SCOPES = [
    "https://www.googleapis.com/auth/adwords",
    "https://www.googleapis.com/auth/business.manage",
]

client_config = {
    "installed": {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uris": ["http://localhost:8080"],
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
}

print("Opening browser for Google OAuth consent...")
print("Sign in with the Google account that owns your Google Ads account.\n")

flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
credentials = flow.run_local_server(port=8080, prompt="consent", access_type="offline")

print("\n" + "=" * 60)
print("SUCCESS — add this to your .env file:")
print("=" * 60)
print(f"GOOGLE_ADS_REFRESH_TOKEN={credentials.refresh_token}")
print("=" * 60)
print("\nThis same token covers Google Ads AND Google Business Profile.")
print("You do NOT need to run this again unless you revoke access.")
