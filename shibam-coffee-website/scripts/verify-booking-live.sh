#!/usr/bin/env bash
# Checks that the booking feature works on a deployed site.
#   scripts/verify-booking-live.sh https://shibamatlanta.com
# Checks (retrying while a new Pages deployment finishes):
#   1. /book/<token> serves the booking page, so the Cloudflare rewrite works.
#   2. POST /api/book getLink with a made-up token answers 404 "link_not_found".
#      That proves the new function is live AND the new database tables exist
#      (without the migrations this answers 500 "server_error").
# Set CHECK_API=0 to skip check 2 (used when testing against a static server).
set -u
SITE="${1:?usage: verify-booking-live.sh https://your-site}"
SITE="${SITE%/}"
TRIES="${TRIES:-30}"
DELAY="${DELAY:-10}"
FAKE="$(printf 'a%.0s' $(seq 1 43))"

check_page() {
  local body status
  body="$(mktemp)"
  status="$(curl -sS -m 20 -o "$body" -w '%{http_code}' "$SITE/book/$FAKE" 2>/dev/null || echo 000)"
  if [ "$status" = "200" ] && grep -q 'id="booking-app"' "$body"; then rm -f "$body"; return 0; fi
  echo "  page check: HTTP $status (expected 200 with the booking page)"
  rm -f "$body"; return 1
}

check_api() {
  local body status
  body="$(mktemp)"
  status="$(curl -sS -m 20 -o "$body" -w '%{http_code}' -X POST "$SITE/api/book" \
    -H 'Content-Type: application/json' -d "{\"action\":\"getLink\",\"token\":\"$FAKE\"}" 2>/dev/null || echo 000)"
  if [ "$status" = "404" ] && grep -q 'link_not_found' "$body"; then rm -f "$body"; return 0; fi
  echo "  api check: HTTP $status $(head -c 120 "$body") (expected 404 link_not_found)"
  rm -f "$body"; return 1
}

attempt=1
while [ "$attempt" -le "$TRIES" ]; do
  ok=1
  check_page || ok=0
  if [ "${CHECK_API:-1}" = "1" ]; then check_api || ok=0; fi
  if [ "$ok" = "1" ]; then
    echo "OK: the booking page and API are live at $SITE"
    exit 0
  fi
  echo "Attempt $attempt of $TRIES failed; waiting ${DELAY}s (a new deployment may still be finishing)..."
  attempt=$((attempt + 1))
  sleep "$DELAY"
done
echo "FAILED: the booking feature is not working at $SITE. See the messages above."
exit 1
