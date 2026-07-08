"""Structured logging with automatic credential masking."""

from __future__ import annotations

import logging
import sys

from app.core.security import mask_credentials


class CredentialMaskFilter(logging.Filter):
    """Masks user:password@ patterns in every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = mask_credentials(str(record.msg))
        if record.args:
            record.args = tuple(
                mask_credentials(a) if isinstance(a, str) else a for a in record.args
            )
        return True


def setup_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(level.upper())
    # Avoid duplicate handlers on reload
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    handler.addFilter(CredentialMaskFilter())
    root.addHandler(handler)

    # Quiet down noisy third-party loggers
    for noisy in ("uvicorn.access", "ultralytics"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
