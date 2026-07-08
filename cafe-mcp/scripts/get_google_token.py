"""
One-time script to generate a Google OAuth refresh token for Gmail and Google Sheets.

IMPORTANT: Run this logged into the Google account yemenicoffeeco@gmail.com.
If you're logged into another Google account in your browser, use an incognito
window and sign in as yemenicoffeeco@gmail.com.

Run once:
    python scripts/get_google_token.py

Before running:
    1. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env
    2. Enable Gmail API and Google Sheets API at console.cloud.google.com → Library
    3. Add http://localhost:8080 as an authorized redirect URI for your OAuth app

Copy GOOGLE_REFRESH_TOKEN from the output into your .env file.
This single token covers both Gmail and Google Sheets.
"""
import os
import sys
from google_auth_oauthlib.flow import InstalledAppFlow
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")

if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.")
    sys.exit(1)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
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
print("IMPORTANT: Sign in as yemenicoffeeco@gmail.com\n")
print("Permissions requested:")
print("  - gmail.readonly (read invoice emails only — cannot send or delete)")
print("  - spreadsheets (read and write inventory/ledger sheets)\n")

flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
credentials = flow.run_local_server(port=8080, prompt="consent", access_type="offline")

print("\n" + "=" * 60)
print("SUCCESS — add this to your .env file:")
print("=" * 60)
print(f"GOOGLE_REFRESH_TOKEN={credentials.refresh_token}")
print("=" * 60)
print("\nThis token covers both Gmail and Google Sheets.")
print("You do NOT need to run this again unless you revoke access.")
