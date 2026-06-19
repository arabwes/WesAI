"""OpenAI client for structured invoice extraction from PDFs and images."""
import json
import logging
from typing import Optional
from openai import OpenAI
from config import config, NotConfiguredError

logger = logging.getLogger(__name__)

_client: Optional[OpenAI] = None

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


def get_client() -> OpenAI:
    global _client
    if not config.openai_ready:
        raise NotConfiguredError(
            "OpenAI not configured. Set OPENAI_API_KEY in your .env. "
            "Get a key at: platform.openai.com → API keys → Create new secret key."
        )
    if _client is None:
        _client = OpenAI(api_key=config.openai_api_key)
    return _client


def _to_openai_content(content_block: dict) -> list:
    """Convert a pdf_utils content block to OpenAI message content format."""
    if content_block["type"] == "text":
        return [{"type": "text", "text": content_block["text"]}]

    source = content_block.get("source", {})
    media_type = source.get("media_type", "")
    data = source.get("data", "")

    if media_type == "application/pdf":
        # Scanned PDF — OpenAI vision doesn't accept raw PDF bytes.
        # Return a note so the caller knows to flag this for manual entry.
        return [{"type": "text", "text": "(scanned PDF — text could not be extracted automatically)"}]

    # JPEG or PNG image
    return [{
        "type": "image_url",
        "image_url": {"url": f"data:{media_type};base64,{data}", "detail": "high"},
    }]


def parse_invoice(content_block: dict, filename: str = "") -> dict:
    """Send a PDF/image content block to GPT-4o-mini and return structured invoice data.

    content_block: dict from pdf_utils.attachment_to_content()
    Returns: parsed invoice dict, or dict with parse_error key on failure
    """
    client = get_client()
    openai_content = _to_openai_content(content_block)
    openai_content.append({"type": "text", "text": _EXTRACTION_PROMPT})

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=2048,
            messages=[{"role": "user", "content": openai_content}],
        )
        raw = response.choices[0].message.content.strip()

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
        logger.error("OpenAI returned invalid JSON for %s: %s", filename, e)
        # Retry once with a stricter prompt
        try:
            strict_content = _to_openai_content(content_block) + [{
                "type": "text",
                "text": _EXTRACTION_PROMPT + "\n\nIMPORTANT: Your response must start with { and end with }. No other text.",
            }]
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                max_tokens=2048,
                messages=[{"role": "user", "content": strict_content}],
            )
            raw = response.choices[0].message.content.strip()
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
        logger.error("OpenAI API call failed for %s: %s", filename, e)
        return {
            "parse_error": True,
            "error_detail": str(e),
            "_filename": filename,
            "vendor_name": "",
            "order_number": "",
            "line_items": [],
            "invoice_total": None,
        }
