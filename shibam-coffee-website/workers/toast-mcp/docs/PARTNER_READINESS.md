# Toast partner readiness

Partner code is present but disabled by default. Activation is externally blocked until Toast approves the integration, supplies a partner API account, creates the webhook subscription, and completes sandbox/certification/alpha/beta stages.

Implemented controls:

- Per-organization opaque `externalGroupRef` claim code.
- HMAC-SHA256 verification over the exact raw body plus embedded timestamp before payload parsing.
- GUID replay deduplication and out-of-order event suppression.
- Unknown or missing claim codes quarantine; no email matching.
- `partner_removed` immediately deactivates the location before acknowledgment.
- Added/updated events queue after verification.
- Eight-hour `/partners/v1/connectedRestaurants` reconciliation with pagination and rate handling.
- BYO overlap leaves the BYO location active while recording a pending partner connection; an owner must confirm the atomic switch. The unused BYO secret is erased only when no other locations use it.
- A local partner disconnect is preserved across reconciliation updates. A new signed `partner_added` event can reactivate it after the restaurant installs again.

Before enabling, validate real Toast fixtures for each webhook event and document the assigned subscription's retry behavior. Add production alerting for signature failures, quarantine, DLQ depth, reconciliation mismatch, partner 401/429 rates, and location removals.
