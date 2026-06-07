"""PDF and image attachment utilities for the email invoice parser."""
import base64
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_PDF_MAGIC = b"%PDF"
_PNG_MAGIC = b"\x89PNG"
_JPEG_MAGIC = b"\xff\xd8\xff"


def decode_attachment(data: str) -> bytes:
    """Decode a base64url-encoded Gmail attachment payload."""
    # Gmail uses URL-safe base64 (- and _ instead of + and /)
    padded = data.replace("-", "+").replace("_", "/")
    missing_padding = len(padded) % 4
    if missing_padding:
        padded += "=" * (4 - missing_padding)
    return base64.b64decode(padded)


def is_pdf(data: bytes) -> bool:
    return data[:4] == _PDF_MAGIC


def is_image(data: bytes) -> bool:
    return data[:3] == _JPEG_MAGIC or data[:4] == _PNG_MAGIC


def extract_text_from_pdf(data: bytes) -> Optional[str]:
    """Extract embedded text from a digital PDF using pdfplumber.
    Returns None if the PDF is scanned/image-only."""
    try:
        import pdfplumber
        import io
        text_parts = []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    text_parts.append(text)
        result = "\n".join(text_parts).strip()
        # If we got very little text, the PDF is likely scanned
        return result if len(result) > 50 else None
    except Exception as e:
        logger.warning("pdfplumber extraction failed: %s", e)
        return None


def attachment_to_content(data: bytes, mime_type: str) -> dict:
    """Convert attachment bytes to a format suitable for Claude API.

    For digital PDFs: extract text and send as text content (cheaper).
    For scanned PDFs or images: send as base64 image content.
    """
    if is_pdf(data):
        text = extract_text_from_pdf(data)
        if text:
            return {"type": "text", "text": text}
        # Scanned PDF — encode as image (first page only via base64)
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": base64.standard_b64encode(data).decode(),
            },
        }
    elif is_image(data):
        media = "image/jpeg" if data[:3] == _JPEG_MAGIC else "image/png"
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media,
                "data": base64.standard_b64encode(data).decode(),
            },
        }
    else:
        # Unknown type — try as text
        try:
            return {"type": "text", "text": data.decode("utf-8", errors="ignore")}
        except Exception:
            return {"type": "text", "text": "(unreadable attachment)"}
