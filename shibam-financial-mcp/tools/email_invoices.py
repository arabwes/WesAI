"""Email Invoice MCP tools — fetches vendor invoice PDFs from Gmail and returns extracted text.

The AI agent calling these tools is responsible for parsing the text into structured data.
Pipeline: Gmail API → search by vendor domain → retrieve attachments →
          extract PDF text (pdfplumber) → return raw text for AI to parse.

Adding a new vendor requires only adding VENDOR_<NAME>=<domain> to .env — no code changes.
"""
import json
import logging
from datetime import date
from typing import Optional
from clients.gmail_client import search_threads, get_thread_messages, get_attachment_data, extract_message_parts
from clients.sheets_client import (
    get_service as get_sheets_service,
    LEDGER_REQUIRED_COLUMNS,
    ensure_ledger_tab,
    sheet_to_dicts,
    append_rows,
)
from config import config
from utils.pdf_utils import attachment_to_content
from utils.formatting import fmt_currency, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB


def _build_gmail_query(start_date: str, end_date: str, vendor_domain: str = "") -> str:
    parts = [f"after:{start_date.replace('-', '/')}", f"before:{end_date.replace('-', '/')}"]
    if vendor_domain:
        parts.append(f"from:{vendor_domain}")
    else:
        domain_terms = [f"from:{d}" for d in config.vendor_domains.values() if d]
        if domain_terms:
            parts.append("({})".format(" OR ".join(domain_terms)))
    parts.append("has:attachment")
    return " ".join(parts)


def _fetch_email_attachments(start_date: str, end_date: str, vendor_filter: str = "") -> list:
    """Fetch attachment text from vendor invoice emails.

    Returns list of dicts: {text, filename, email_subject, email_date, sender, fetch_error}
    """
    if vendor_filter:
        domain = next(
            (d for name, d in config.vendor_domains.items() if vendor_filter.lower() in name.lower()),
            vendor_filter,
        )
        query = _build_gmail_query(start_date, end_date, domain)
    else:
        query = _build_gmail_query(start_date, end_date)

    if not any(config.vendor_domains.values()):
        return [{"fetch_error": "No vendor domains configured. Add VENDOR_* variables to .env."}]

    threads = search_threads(query, max_results=200)
    if not threads:
        return []

    results = []
    for thread in threads:
        messages = get_thread_messages(thread["id"])
        for message in messages:
            subject, msg_date, sender, attachments = extract_message_parts(message)
            if not attachments:
                continue

            for att in attachments:
                if att["size"] > _MAX_ATTACHMENT_SIZE_BYTES:
                    logger.warning("Skipping large attachment %s (%d bytes)", att["filename"], att["size"])
                    continue

                try:
                    raw_bytes = get_attachment_data(message["id"], att["attachment_id"])
                    content_block = attachment_to_content(raw_bytes, att["mime_type"])

                    if content_block["type"] == "text":
                        text = content_block["text"]
                        is_scanned = False
                    else:
                        # Scanned PDF or image — pdfplumber couldn't extract text
                        text = "(scanned PDF — text extraction not available; manual entry required)"
                        is_scanned = True

                    results.append({
                        "text": text,
                        "filename": att["filename"],
                        "email_subject": subject,
                        "email_date": msg_date,
                        "sender": sender,
                        "is_scanned": is_scanned,
                    })
                except Exception as e:
                    logger.error("Failed to fetch attachment %s from '%s': %s", att["filename"], subject, e)
                    results.append({
                        "fetch_error": str(e),
                        "filename": att["filename"],
                        "email_subject": subject,
                        "email_date": msg_date,
                        "sender": sender,
                    })

    return results


@api_retry()
async def parse_vendor_invoices(
    start_date: str,
    end_date: str,
    vendor: str = "",
) -> str:
    """
    Fetch vendor invoice PDFs from yemenicoffeeco@gmail.com and return their text content.

    Downloads all PDF and image attachments from vendor invoice emails, extracts the text
    using pdfplumber, and returns the raw content for you to parse into structured data.

    Configured vendors: Restaurant Depot, Instacart, Webstaurant, Barista Underground
    (add more via VENDOR_* environment variables).

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        vendor:     optional — filter to one vendor (partial name match, e.g., "Webstaurant")
    """
    try:
        if not config.vendor_domains:
            return (
                "No vendor domains configured.\n"
                "Add VENDOR_* variables to your .env file, e.g.:\n"
                "  VENDOR_RESTAURANT_DEPOT=restaurantdepot.com\n"
                "No code changes needed to add new vendors."
            )

        attachments = _fetch_email_attachments(start_date, end_date, vendor)

        if not attachments:
            vendor_str = f" from {vendor}" if vendor else ""
            return f"No invoice emails found{vendor_str} between {start_date} and {end_date}."

        ok = [a for a in attachments if not a.get("fetch_error")]
        errors = [a for a in attachments if a.get("fetch_error")]

        lines = [
            f"Vendor Invoice Attachments — {start_date} to {end_date}",
            f"Found: {len(ok)} attachments  |  Fetch errors: {len(errors)}",
            f"",
        ]

        for i, att in enumerate(ok, 1):
            lines += [
                f"{'─' * 60}",
                f"[{i}] {att['filename']}",
                f"From:    {att['sender']}",
                f"Date:    {att['email_date']}",
                f"Subject: {att['email_subject']}",
                f"",
                att["text"],
                f"",
            ]

        if errors:
            lines += [f"{'─' * 60}", f"⚠️  {len(errors)} attachments could not be fetched:"]
            for err in errors:
                lines.append(f"  • {err.get('filename', '?')} — {err.get('fetch_error', '')[:100]}")

        return "\n".join(lines)

    except Exception as e:
        logger.error("parse_vendor_invoices failed: %s", e)
        return f"Error fetching vendor invoices: {e}"


@api_retry()
async def vendor_spend_summary(start_date: str, end_date: str) -> str:
    """
    Fetch all vendor invoice text for a date range for spend analysis.

    Returns the raw invoice text from all configured vendor domains.
    Use this to analyze total spend, compare vendors, or identify cost trends.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    return await parse_vendor_invoices(start_date, end_date)


@api_retry()
async def invoice_reconciliation_check(start_date: str, end_date: str) -> str:
    """
    Fetch all vendor invoice text for reconciliation against QuickBooks.

    Returns raw invoice content so you can cross-reference amounts and order numbers
    against QuickBooks transactions using the QuickBooks connector.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    try:
        attachments = _fetch_email_attachments(start_date, end_date)
        ok = [a for a in attachments if not a.get("fetch_error") and not a.get("is_scanned")]
        errors = [a for a in attachments if a.get("fetch_error")]

        if not ok:
            return f"No vendor invoices found between {start_date} and {end_date}."

        lines = [
            f"Invoice Reconciliation — {start_date} to {end_date}",
            f"{len(ok)} invoices retrieved from Gmail",
            f"",
            f"Review each invoice below, then use the QuickBooks connector to verify",
            f'each appears as a Bill or Purchase. Ask: "Show vendor bills from {start_date} to {end_date}"',
            f"",
        ]

        for i, att in enumerate(ok, 1):
            lines += [
                f"{'─' * 60}",
                f"[{i}] {att['filename']}  |  {att['email_date']}  |  {att['sender']}",
                f"",
                att["text"][:1000] + ("..." if len(att["text"]) > 1000 else ""),
                f"",
            ]

        if errors:
            lines += [f"⚠️  {len(errors)} fetch errors — see parse_vendor_invoices for details."]

        return "\n".join(lines)

    except Exception as e:
        logger.error("invoice_reconciliation_check failed: %s", e)
        return f"Error running invoice reconciliation check: {e}"


@api_retry()
async def invoice_ledger_sync(
    start_date: str,
    end_date: str,
    invoice_data: str = "",
) -> str:
    """
    Write parsed invoice line items to the Invoice Ledger Google Sheet.

    Two-step workflow:
      1. Call parse_vendor_invoices to get raw invoice text
      2. Parse the text into structured data, then call this tool with invoice_data

    Args:
        start_date:   YYYY-MM-DD — used for the sheet log only
        end_date:     YYYY-MM-DD — used for the sheet log only
        invoice_data: JSON array of invoice objects. Each object must have:
                      vendor_name, order_date (YYYY-MM-DD), order_number,
                      invoice_total (number), line_items (array of objects with
                      description, quantity, unit, unit_cost, line_total)

    If invoice_data is omitted, returns the raw invoice text for you to parse.
    """
    if not invoice_data:
        # No structured data provided — return raw text for AI to parse
        raw = await parse_vendor_invoices(start_date, end_date)
        return (
            f"No invoice_data provided. Parse the invoices below, then call\n"
            f"invoice_ledger_sync again with invoice_data='[{{...}}]'.\n\n"
            + raw
        )

    ledger_id = config.sheets_ledger_id
    if not ledger_id:
        return (
            "GOOGLE_SHEETS_LEDGER_ID is not set.\n"
            "Create a Google Sheet for the invoice ledger and add its ID to .env."
        )

    try:
        invoices = json.loads(invoice_data)
    except json.JSONDecodeError as e:
        return f"invoice_data is not valid JSON: {e}"

    try:
        ensure_ledger_tab(ledger_id)
        error, existing_rows = sheet_to_dicts(ledger_id, "Ledger", LEDGER_REQUIRED_COLUMNS)
        if error:
            return f"Cannot read Invoice Ledger sheet: {error}"

        existing_order_numbers = {str(r.get("Order #", "")).strip() for r in existing_rows if r.get("Order #")}
        today_str = str(date.today())
        new_rows = []
        skipped = 0

        for inv in invoices:
            order_num = str(inv.get("order_number", "") or "").strip()
            if order_num and order_num in existing_order_numbers:
                skipped += 1
                continue

            vendor = inv.get("vendor_name", "Unknown")
            inv_date = inv.get("order_date", "")
            inv_total = inv.get("invoice_total")
            inv_total_str = fmt_currency(float(inv_total)) if inv_total is not None else ""
            line_items = inv.get("line_items", [])

            if not line_items:
                new_rows.append([inv_date, order_num, vendor, "(no line items)", "", "", "", "", inv_total_str, today_str])
            else:
                for li in line_items:
                    qty = li.get("quantity", "")
                    unit_cost = li.get("unit_cost")
                    line_total = li.get("line_total")
                    new_rows.append([
                        inv_date, order_num, vendor,
                        li.get("description", "")[:100],
                        str(qty) if qty is not None else "",
                        str(li.get("unit", "")),
                        fmt_currency(float(unit_cost)) if unit_cost is not None else "",
                        fmt_currency(float(line_total)) if line_total is not None else "",
                        inv_total_str, today_str,
                    ])
            if order_num:
                existing_order_numbers.add(order_num)

        if new_rows:
            append_rows(ledger_id, "Ledger", new_rows)

        parse_errors = 0
        return "\n".join([
            f"Invoice Ledger Sync — {start_date} to {end_date}",
            f"",
            f"Invoices received:   {len(invoices)}",
            f"New rows added:      {len(new_rows)}",
            f"Duplicates skipped:  {skipped}",
            f"",
            f"Ledger: docs.google.com/spreadsheets/d/{ledger_id}",
        ])

    except Exception as e:
        logger.error("invoice_ledger_sync failed: %s", e)
        return f"Error syncing invoice ledger: {e}"
