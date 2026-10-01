# Operation receipts and stale-state protection

Operation fingerprints must be calculated from a canonical representation of
`actor`, operation kind, and payload. The same logical request therefore gets
one stable fingerprint even when JSON object keys arrive in a different order.

Receipts should move through `pending -> submitted -> confirmed` (or
`failed`). A duplicate fingerprint returns the existing receipt rather than
submitting a second operation. Receipt lookup must remain actor-scoped; a
fingerprint is not an authorization credential.

Before an irreversible submission, compare the preparation snapshot with the
authoritative network state. A ledger-sequence mismatch requires a fresh
simulation, a cache-version mismatch requires a refresh, and a network or
wallet mismatch requires restarting preparation. The comparison is exposed as
the pure `detectStateDrift` helper so adapters can enforce the same rule at
HTTP, worker, and CLI boundaries.
