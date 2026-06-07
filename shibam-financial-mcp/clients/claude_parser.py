"""Claude API client for structured invoice extraction from PDFs and images."""
import json
import logging
from typing import Optional
from anthropic import Anthropic
from config import config

logger = logging.getLogger(__name__)

_client: Optional[Anthropic] = None

_EXTRACTION_PROMPT = """Extract the following fields from this invoice or order confirmation document.
Return ONLY a valid JSON object with no extra text before or after it.

Required JSON structure:
{
  "vendor_name": "string",
  "order_date": "YYYY-MM-DD or empty string",
  "order_number": "string or empty string",
  "line_items": [
    {
      "description": "string",
      "quantity": number_or_null,
      "unit": "string or empty",
      "unit_cost": number_or_null,
      "line_total": number_or_null
    }
  ],
  "subtotal": number_or_null,
  "tax": number_or_null,
  "shipping": number_or_null,
  "invoice_total": number_or_null,
  "notes": "any important notes or empty string"
}

If a field is not present in the document, use null for numbers and empty string for strings.
Do not invent or guess values — only extract what is clearly stated in the document."""


def get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(api_key=config.anthropic_api_key)
    return _client


def parse_invoice(content_block: dict, filename: str = "") -> dict:
    """Send a PDF/image content block to Claude and return structured invoice data.

    content_block: dict from pdf_utils.attachment_to_content()
    Returns: parsed invoice dict, or dict with parse_error key on failure
    """
    client = get_client()

    try:
        response = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=2048,
            messages=[
                {
                    "role": "user",
                    "content": [
                        content_block,
                        {"type": "text", "text": _EXTRACTION_PROMPT},
                    ],
                }
            ],
        )

        raw = response.content[0].text.strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        parsed = json.loads(raw)
        parsed["_filename"] = filename
        return parsed

    except json.JSONDecodeError as e:
        logger.error("Claude returned invalid JSON for %s: %s", filename, e)
        # Retry once with a stricter prompt
        try:
            response = client.messages.create(
                model="claude-opus-4-8",
                max_tokens=2048,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            content_block,
                            {
                                "type": "text",
                                "text": _EXTRACTION_PROMPT + "\n\nIMPORTANT: Your response must start with { and end with }. No other text.",
                            },
                        ],
                    }
                ],
            )
            raw = response.content[0].text.strip()
            parsed = json.loads(raw)
            parsed["_filename"] = filename
            return parsed
        except Exception as retry_err:
            logger.error("Retry parse also failed for %s: %s", filename, retry_err)
            return {
                "parse_error": True,
                "error_detail": str(retry_err),
                "_filename": filename,
                "vendor_name": "",
                "order_number": "",
                "line_items": [],
                "invoice_total": None,
            }

    except Exception as e:
        logger.error("Claude API call failed for %s: %s", filename, e)
        return {
            "parse_error": True,
            "error_detail": str(e),
            "_filename": filename,
            "vendor_name": "",
            "order_number": "",
            "line_items": [],
            "invoice_total": None,
        }
