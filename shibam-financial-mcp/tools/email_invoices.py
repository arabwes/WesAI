"""Email Invoice Parser MCP tools — 4 tools using Gmail + Claude API to parse vendor invoices.

Pipeline: Gmail API → search by vendor domain → retrieve attachments →
          extract PDF text (pdfplumber) or send image to Claude API →
          return structured JSON line items.

Adding a new vendor requires only adding VENDOR_<NAME>=<domain> to .env — no code changes.
"""
import logging
from datetime import date
from typing import Optional
from clients.gmail_client import search_threads, get_thread_messages, get_attachment_data, extract_message_parts
from clients.claude_parser import parse_invoice
from clients.sheets_client import (
    get_service as get_sheets_service,
    LEDGER_REQUIRED_COLUMNS,
    ensure_ledger_tab,
    sheet_to_dicts,
)
from config import config
from utils.pdf_utils import attachment_to_content
from utils.formatting import fmt_currency, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB


def _build_gmail_query(start_date: str, end_date: str, vendor_domain: str = "") -> str:
    """Build a Gmail search query for vendor invoice emails."""
    parts = [f"after:{start_date.replace('-', '/')}", f"before:{end_date.replace('-', '/')}"]
    if vendor_domain:
        parts.append(f"from:{vendor_domain}")
    else:
        # Search all configured vendor domains
        domain_terms = [f"from:{d}" for d in config.vendor_domains.values() if d]
        if domain_terms:
            parts.append("({})".format(" OR ".join(domain_terms)))
    parts.append("has:attachment")
    return " ".join(parts)


def _parse_email_invoices(start_date: str, end_date: str, vendor_filter: str = "") -> list:
    """Core parsing logic — returns list of parsed invoice dicts."""
    # Determine which domain(s) to search
    if vendor_filter:
        # Find domain by vendor name match
        domain = next(
            (d for name, d in config.vendor_domains.items() if vendor_filter.lower() in name.lower()),
            vendor_filter,  # Fall back to treating the filter as a domain directly
        )
        query = _build_gmail_query(start_date, end_date, domain)
    else:
        query = _build_gmail_query(start_date, end_date)

    if not any(config.vendor_domains.values()):
        return [{"parse_error": True, "error_detail": "No vendor domains configured. Add VENDOR_* variables to .env."}]

    threads = search_threads(query, max_results=200)
    if not threads:
        logger.info("No email threads found for query: %s", query)
        return []

    parsed_invoices = []
    for thread in threads:
        messages = get_thread_messages(thread["id"])
        for message in messages:
            subject, msg_date, sender, attachments = extract_message_parts(message)
            if not attachments:
                continue

            for att in attachments:
                if att["size"] > _MAX_ATTACHMENT_SIZE_BYTES:
                    logger.warning("Skipping large attachment %s (%d bytes) from %s", att["filename"], att["size"], subject)
                    continue

                try:
                    raw_bytes = get_attachment_data(message["id"], att["attachment_id"])
                    content_block = attachment_to_content(raw_bytes, att["mime_type"])
                    invoice = parse_invoice(content_block, filename=att["filename"])
                    invoice["_email_subject"] = subject
                    invoice["_email_date"] = msg_date
                    invoice["_sender"] = sender
                    parsed_invoices.append(invoice)
                except Exception as e:
                    logger.error("Failed to parse attachment %s from '%s': %s", att["filename"], subject, e)
                    parsed_invoices.append({
                        "parse_error": True,
                        "error_detail": str(e),
                        "_filename": att["filename"],
                        "_email_subject": subject,
                        "_email_date": msg_date,
                        "vendor_name": "",
                        "order_number": "",
                        "line_items": [],
                        "invoice_total": None,
                    })

    return parsed_invoices


@api_retry()
async def parse_vendor_invoices(
    start_date: str,
    end_date: str,
    vendor: str = "",
) -> str:
    """
    Search yemenicoffeeco@gmail.com for vendor invoices and parse them with Claude AI.

    Searches all configured vendor domains by default, or filters to one vendor.
    Extracts: vendor name, order date, order number, line items (description/qty/cost),
    subtotal, tax, shipping, and invoice total from each PDF or image attachment.

    Configured vendors: Restaurant Depot, Instacart, Webstaurant, Barista Underground,
    Franchisor, Dessert Vendor (add more via VENDOR_* environment variables).

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        vendor:     optional — filter to one vendor (partial name match, e.g., "Restaurant Depot")
    """
    try:
        if not config.vendor_domains:
            return (
                "No vendor domains configured.\n"
                "Add VENDOR_* variables to your .env file, for example:\n"
                "  VENDOR_RESTAURANT_DEPOT=restaurantdepot.com\n"
                "No code changes are needed to add new vendors."
            )

        invoices = _parse_email_invoices(start_date, end_date, vendor)

        if not invoices:
            vendor_str = f" from {vendor}" if vendor else ""
            return f"No invoice emails found{vendor_str} between {start_date} and {end_date}."

        success = [i for i in invoices if not i.get("parse_error")]
        errors = [i for i in invoices if i.get("parse_error")]

        lines = [
            f"Vendor Invoice Parse Results — {start_date} to {end_date}",
            f"Parsed: {len(success)} invoices  |  Errors: {len(errors)}",
            f"",
        ]

        for inv in success:
            total = inv.get("invoice_total")
            item_count = len(inv.get("line_items", []))
            lines += [
                f"────────────────────────────────────────",
                f"Vendor:       {inv.get('vendor_name', 'Unknown')}",
                f"Order Date:   {inv.get('order_date', '—')}",
                f"Order #:      {inv.get('order_number', '—')}",
                f"Invoice Total:{fmt_currency(float(total)) if total else '—'}",
                f"Line Items:   {item_count}",
            ]
            if inv.get("line_items"):
                item_rows = [{
                    "Description": li.get("description", "")[:40],
                    "Qty": str(li.get("quantity", "—")),
                    "Unit Cost": fmt_currency(float(li["unit_cost"])) if li.get("unit_cost") else "—",
                    "Total": fmt_currency(float(li["line_total"])) if li.get("line_total") else "—",
                } for li in inv["line_items"][:20]]
                lines.append(fmt_table(item_rows, ["Description", "Qty", "Unit Cost", "Total"]))
            lines.append("")

        if errors:
            lines += [f"", f"⚠️  {len(errors)} attachments could not be parsed:"]
            for err in errors:
                lines.append(f"  • {err.get('_filename', '?')} from '{err.get('_email_subject', '?')}' — {err.get('error_detail', '')[:80]}")

        return "\n".join(lines)

    except Exception as e:
        logger.error("parse_vendor_invoices failed: %s", e)
        return f"Error parsing vendor invoices: {e}"


@api_retry()
async def vendor_spend_summary(start_date: str, end_date: str) -> str:
    """
    Aggregate parsed vendor invoice spend — total per vendor, order count, average order value.

    Calls parse_vendor_invoices internally and aggregates results.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    try:
        invoices = _parse_email_invoices(start_date, end_date)
        success = [i for i in invoices if not i.get("parse_error") and i.get("vendor_name")]

        if not success:
            return f"No vendor invoices found or parsed for {start_date} to {end_date}."

        vendor_data: dict = {}
        for inv in success:
            vendor = inv.get("vendor_name", "Unknown")
            total = float(inv.get("invoice_total") or 0)
            if vendor not in vendor_data:
                vendor_data[vendor] = {"total": 0.0, "count": 0}
            vendor_data[vendor]["total"] += total
            vendor_data[vendor]["count"] += 1

        grand_total = sum(v["total"] for v in vendor_data.values())
        rows = []
        for vendor, data in sorted(vendor_data.items(), key=lambda x: -x[1]["total"]):
            avg = data["total"] / data["count"] if data["count"] else 0
            rows.append({
                "Vendor": vendor[:35],
                "Orders": str(data["count"]),
                "Total Spend": fmt_currency(data["total"]),
                "Avg Order": fmt_currency(avg),
            })

        cols = ["Vendor", "Orders", "Total Spend", "Avg Order"]
        return (
            f"Vendor Spend Summary — {start_date} to {end_date}\n"
            f"Grand total (all vendors): {fmt_currency(grand_total)}\n\n"
            + fmt_table(rows, cols)
        )

    except Exception as e:
        logger.error("vendor_spend_summary failed: %s", e)
        return f"Error generating vendor spend summary: {e}"


@api_retry()
async def invoice_reconciliation_check(start_date: str, end_date: str) -> str:
    """
    Compare parsed Gmail invoices against QuickBooks vendor transactions.

    Flags invoices that appear in email but have no matching QuickBooks entry —
    these are likely unbooked expenses that need to be recorded.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    try:
        # Get parsed email invoices
        email_invoices = _parse_email_invoices(start_date, end_date)
        success = [i for i in email_invoices if not i.get("parse_error") and i.get("invoice_total")]

        # Get QuickBooks vendor transactions
        from clients.quickbooks_client import qb_query
        qb_purchases = qb_query(
            f"SELECT * FROM Purchase WHERE TxnDate >= '{start_date}' AND TxnDate <= '{end_date}' MAXRESULTS 500"
        )
        qb_bills = qb_query(
            f"SELECT * FROM Bill WHERE TxnDate >= '{start_date}' AND TxnDate <= '{end_date}' MAXRESULTS 500"
        )

        # Build a set of QB transaction amounts for fuzzy matching (within $1)
        qb_amounts = set()
        for txn in qb_purchases + qb_bills:
            amt = round(float(txn.get("TotalAmt", 0)), 0)
            qb_amounts.add(amt)

        unmatched = []
        matched_count = 0
        for inv in success:
            total = float(inv.get("invoice_total") or 0)
            rounded = round(total, 0)
            # Check if any QB transaction amount is within $1 of this invoice
            is_matched = any(abs(rounded - qa) <= 1 for qa in qb_amounts)
            if is_matched:
                matched_count += 1
            else:
                unmatched.append({
                    "Vendor": inv.get("vendor_name", "Unknown")[:30],
                    "Order #": inv.get("order_number", "—")[:20],
                    "Date": inv.get("order_date", "—"),
                    "Amount": fmt_currency(total),
                    "Source": "Gmail invoice",
                })

        lines = [
            f"Invoice Reconciliation Check — {start_date} to {end_date}",
            f"",
            f"Email invoices found:     {len(success)}",
            f"Matched in QuickBooks:    {matched_count}",
            f"Unmatched (unbooked?):    {len(unmatched)}",
        ]

        if unmatched:
            lines += [
                f"",
                f"⚠️  These invoices were NOT found in QuickBooks — likely unrecorded expenses:",
                fmt_table(unmatched, ["Vendor", "Order #", "Date", "Amount", "Source"]),
                f"",
                f"Action: enter these in QuickBooks under the correct vendor and expense category.",
            ]
        else:
            lines.append("\n✅  All parsed invoices have matching QuickBooks entries.")

        return "\n".join(lines)

    except Exception as e:
        logger.error("invoice_reconciliation_check failed: %s", e)
        return f"Error running invoice reconciliation check: {e}"


@api_retry()
async def invoice_ledger_sync(start_date: str, end_date: str) -> str:
    """
    Parse all vendor invoices from Gmail and sync new line items to the Invoice Ledger Google Sheet.

    Deduplicates by Order # — invoices already in the sheet are skipped.
    The Ledger sheet is created automatically if the tab doesn't exist.

    Args:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
    """
    try:
        ledger_id = config.sheets_ledger_id
        if not ledger_id:
            return (
                "GOOGLE_SHEETS_LEDGER_ID is not set.\n"
                "Create a Google Sheet for the invoice ledger, copy its ID from the URL, "
                "and add it to .env as GOOGLE_SHEETS_LEDGER_ID."
            )

        # Ensure the Ledger tab exists with correct headers
        ensure_ledger_tab(ledger_id)

        # Read existing Order # values to avoid duplicates
        error, existing_rows = sheet_to_dicts(ledger_id, "Ledger", LEDGER_REQUIRED_COLUMNS)
        if error:
            return f"Cannot read Invoice Ledger sheet: {error}"

        existing_order_numbers = {str(r.get("Order #", "")).strip() for r in existing_rows if r.get("Order #")}

        # Parse new invoices
        invoices = _parse_email_invoices(start_date, end_date)
        success = [i for i in invoices if not i.get("parse_error")]

        today_str = str(date.today())
        new_rows = []
        skipped = 0

        for inv in success:
            order_num = str(inv.get("order_number", "") or "").strip()
            if order_num and order_num in existing_order_numbers:
                skipped += 1
                continue

            vendor = inv.get("vendor_name", "Unknown")
            inv_date = inv.get("order_date", "")
            inv_total = inv.get("invoice_total", "")
            inv_total_str = fmt_currency(float(inv_total)) if inv_total else ""

            line_items = inv.get("line_items", [])
            if not line_items:
                # Add one row even if no line items parsed
                new_rows.append([inv_date, order_num, vendor, "(no line items parsed)", "", "", "", "", inv_total_str, today_str])
            else:
                for li in line_items:
                    qty = li.get("quantity", "")
                    unit = li.get("unit", "")
                    unit_cost = li.get("unit_cost", "")
                    line_total = li.get("line_total", "")
                    new_rows.append([
                        inv_date,
                        order_num,
                        vendor,
                        li.get("description", "")[:100],
                        str(qty) if qty is not None else "",
                        str(unit),
                        fmt_currency(float(unit_cost)) if unit_cost else "",
                        fmt_currency(float(line_total)) if line_total else "",
                        inv_total_str,
                        today_str,
                    ])
            if order_num:
                existing_order_numbers.add(order_num)

        if new_rows:
            from clients.sheets_client import append_rows
            append_rows(ledger_id, "Ledger", new_rows)

        parse_errors = len([i for i in invoices if i.get("parse_error")])
        return (
            f"Invoice Ledger Sync — {start_date} to {end_date}\n"
            f"",
            f"Invoices parsed:     {len(success)}",
            f"New rows added:      {len(new_rows)}",
            f"Duplicates skipped:  {skipped}",
            f"Parse errors:        {parse_errors}",
            f"",
            f"Ledger sheet ID: {ledger_id}",
        )[0] + "\n\n" + "\n".join([
            f"Invoices parsed:     {len(success)}",
            f"New rows added:      {len(new_rows)}",
            f"Duplicates skipped:  {skipped}",
            f"Parse errors:        {parse_errors}",
            f"",
            f"Ledger sheet: docs.google.com/spreadsheets/d/{ledger_id}",
        ])

    except Exception as e:
        logger.error("invoice_ledger_sync failed: %s", e)
        return f"Error syncing invoice ledger: {e}"
