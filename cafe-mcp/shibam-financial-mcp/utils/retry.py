"""Exponential backoff retry decorator for rate-limited API calls."""
import logging
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception, before_sleep_log

logger = logging.getLogger(__name__)


def api_retry(max_attempts: int = 4, min_wait: float = 2, max_wait: float = 16):
    return retry(
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=1, min=min_wait, max=max_wait),
        retry=retry_if_exception(lambda e: not getattr(e, '_no_retry', False)),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
