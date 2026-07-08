"""Gmail API client — searches for vendor invoice emails and retrieves attachments."""
import base64
import logging
import os
from typing import Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from config import config, NotConfiguredError
from mcp_common.tenant import maybe_tenant


def _gmail_address() -> str:
    """The business Gmail address, from tenant settings with env fallback."""
    t = maybe_tenant()
    if t and t.setting("gmail_address"):
        return t.setting("gmail_address")
    return os.getenv("GMAIL_ADDRESS", "")

logger = logging.getLogger(__name__)

_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
]

_service = None


def _get_credentials() -> Credentials:
    return Credentials(
        token=None,
        refresh_token=config.google_refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=config.google_client_id,
        client_secret=config.google_client_secret,
        scopes=_SCOPES,
    )


def get_service():
    global _service
    if not config.google_ready:
        raise NotConfiguredError(
            "Gmail/Sheets not configured. Run: python scripts/get_google_token.py — "
            "sign in with the business Gmail account. Then set GOOGLE_SHEETS_INVENTORY_ID."
        )
    if _service is None:
        _service = build("gmail", "v1", credentials=_get_credentials(), cache_discovery=False)
        logger.info("Gmail API service initialized for %s", _gmail_address() or "configured account")
    return _service


def search_threads(query: str, max_results: int = 100) -> list:
    """Search Gmail and return a list of thread metadata dicts."""
    service = get_service()
    results = []
    page_token = None
    while True:
        kwargs = {"userId": "me", "q": query, "maxResults": min(max_results - len(results), 100)}
        if page_token:
            kwargs["pageToken"] = page_token
        response = service.users().threads().list(**kwargs).execute()
        threads = response.get("threads", [])
        results.extend(threads)
        page_token = response.get("nextPageToken")
        if not page_token or len(results) >= max_results:
            break
    return results


def get_thread_messages(thread_id: str) -> list:
    """Return all messages in a thread."""
    service = get_service()
    thread = service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    return thread.get("messages", [])


def get_attachment_data(message_id: str, attachment_id: str) -> bytes:
    """Download and decode a Gmail attachment."""
    service = get_service()
    attachment = service.users().messages().attachments().get(
        userId="me", messageId=message_id, id=attachment_id
    ).execute()
    from utils.pdf_utils import decode_attachment
    return decode_attachment(attachment["data"])


def extract_message_parts(message: dict) -> tuple:
    """Return (subject, date, sender, list_of_attachment_dicts) from a Gmail message."""
    headers = {h["name"]: h["value"] for h in message.get("payload", {}).get("headers", [])}
    subject = headers.get("Subject", "")
    date = headers.get("Date", "")
    sender = headers.get("From", "")
    attachments = []

    def walk_parts(parts):
        for part in parts:
            mime = part.get("mimeType", "")
            filename = part.get("filename", "")
            body = part.get("body", {})
            if filename and body.get("attachmentId"):
                if mime in ("application/pdf", "image/jpeg", "image/png", "image/gif"):
                    attachments.append({
                        "filename": filename,
                        "mime_type": mime,
                        "attachment_id": body["attachmentId"],
                        "size": body.get("size", 0),
                    })
            if part.get("parts"):
                walk_parts(part["parts"])

    payload = message.get("payload", {})
    if payload.get("parts"):
        walk_parts(payload["parts"])

    return subject, date, sender, attachments
