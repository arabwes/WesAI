"""In-memory token-bucket rate limiter, keyed by API key hash (or client IP in
env-fallback mode). Adequate for a single replica; swap for Redis/Postgres
counters before scaling horizontally."""
from __future__ import annotations

import time


class TokenBucket:
    def __init__(self, rate_per_min: float = 60.0, burst: int = 20):
        self.rate = rate_per_min / 60.0
        self.burst = float(burst)
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, last_ts)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (self.burst, now))
        tokens = min(self.burst, tokens + (now - last) * self.rate)
        if tokens < 1.0:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1.0, now)
        if len(self._buckets) > 10_000:  # bound memory under key churn
            cutoff = now - 300
            self._buckets = {k: v for k, v in self._buckets.items() if v[1] > cutoff}
        return True
