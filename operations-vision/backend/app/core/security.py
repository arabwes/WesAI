"""Credential-safety helpers.

RTSP URLs carry camera passwords; they must never reach logs or API
responses in clear text.
"""

from __future__ import annotations

import re

_CRED_RE = re.compile(r"//([^:/@\s]+):([^@\s]+)@")


def mask_credentials(text: str) -> str:
    """Replace ``user:password@`` in any URL with ``***:***@``."""
    if not text:
        return text
    return _CRED_RE.sub("//***:***@", text)
