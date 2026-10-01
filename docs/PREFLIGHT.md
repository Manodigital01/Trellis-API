# Transaction simulation preflight

The preflight is a deterministic, side-effect-free check that runs **before** a
high-risk operation is submitted. It answers one question: given the operation
and a point-in-time snapshot of account state, may this operation proceed —
and if not, what exactly is wrong and what should the caller do about it?

It lives in `src/preflight`. It is **not** a second simulator: `src/simulator`
runs an Ethereum fork/Monte-Carlo simulation, whereas the preflight is a pure
rule evaluation that never touches a clock, a network or a database.

## Result contract

| Status | Meaning | Caller action |
| --- | --- | --- |
| `success` | Every rule passed. | Submit. |
| `warning` | Non-blocking findings (e.g. an aging snapshot, a fee buffer that is running out, an unverified destination). | Read the findings and decide; submission is permitted. |
| `blocking` | At least one known-invalid condition. | Do **not** submit. Fix the findings and rebuild the operation. |

Each finding carries:

- `code` — stable machine-readable identifier (`INSUFFICIENT_BALANCE`, …);
- `severity` — `blocking`, `warning` or `info` (`info` never changes the status);
- `message` — a short, user-safe explanation;
- `remediation` — the concrete next step;
- `errorCode` — the existing `ErrorCode` from the error taxonomy so the finding
  renders through the standard error envelope;
- `details` — deterministic, non-sensitive supporting values.

Findings are sorted deterministically (blocking first, then by `code`, field and
message), so the same input always produces the same array order.

## Endpoints

```text
POST /api/v1/preflight          -> 200 PreflightResult (always)
POST /api/v1/preflight/assert   -> 200 PreflightResult, or 422 PRECONDITION_FAILED
```

`/preflight` is for rendering a preview; `/preflight/assert` is the gate used
immediately before submission. A blocking result on the assert route is thrown
as `PreflightBlockedException` (an `AppException`), so it is serialized by the
global exception filter with `errorCode: PRECONDITION_FAILED` and the first
blocking remediation as `recoveryGuidance`. Both routes require JWT auth and are
subject to the global KYC guard.

## Rules

| Code | Severity | What it guards |
| --- | --- | --- |
| `INVALID_OPERATION_AMOUNT` | blocking | Amount is not a non-negative decimal string. |
| `OPERATION_EXPIRED` | blocking | `expiresAt` is in the past. |
| `STATE_VERSION_MISMATCH` | blocking | Prepared against a stale `expectedStateVersion`. |
| `STATE_SNAPSHOT_STALE` | blocking | Snapshot age exceeds the hard freshness limit. |
| `STATE_SNAPSHOT_AGING` | warning | Snapshot age exceeds the soft threshold. |
| `BALANCE_STATE_UNAVAILABLE` | blocking | No balance supplied for the operation's asset. |
| `INSUFFICIENT_BALANCE` | blocking | Amount exceeds the available balance. |
| `FEE_BUFFER_EXHAUSTED` | warning | Amount leaves less than the estimated network fee. |
| `INSUFFICIENT_ALLOWANCE` | blocking | Amount exceeds the approved token allowance. |
| `DUPLICATE_OPERATION` | blocking | An identical operation digest was already consumed. |
| `IDEMPOTENCY_KEY_REUSED` | blocking | Key reused with a different payload digest. |
| `IDEMPOTENCY_IN_PROGRESS` | blocking | A request with the same key is still running. |
| `IDEMPOTENT_REPLAY` | info | Same payload already completed; the stored response replays. |
| `POLICY_STATE_UNAVAILABLE` | blocking | Trading policy could not be evaluated. |
| `TRADING_DISABLED` / `INVALID_TRADE_AMOUNT` / `TRADE_AMOUNT_LIMIT_EXCEEDED` / `TRADE_ASSET_NOT_ALLOWED` / `TRADE_SIDE_NOT_ALLOWED` | blocking | Mirrors of the existing `PolicyService` violations for `trade` operations. |
| `ORACLE_PRICE_MISSING` | blocking | An oracle-dependent operation has no price. |
| `ORACLE_PRICE_STALE` | blocking | Oracle price is older than the freshness limit. |
| `DESTINATION_NOT_VERIFIED` | warning | Destination is not on the account's verified list. |

## Determinism

The evaluation core (`evaluatePreflight`) is a pure function of
`{ operation, snapshot, thresholds, asOf }`. It uses no clock, no randomness and
no I/O:

- `preflightId` is `pf:<kind>:<sha256-hex>` derived from the normalised
  operation digest, the state version, `asOf` and the snapshot's `observedAt`.
- `digest` is a SHA-256 over the canonical verdict, so two identical results
  hash identically.
- Object keys are canonicalised recursively and set-like snapshot collections
  (consumed digests, verified destinations, oracle entries) are sorted before
  hashing, so **input array ordering does not affect the result**.
- Amounts are decimal strings compared as scaled `bigint`s, never floats, so
  comparisons are exact and reproducible.

Callers that need reproducibility pass `asOf` explicitly; omitting it uses the
server clock. The snapshot carries its own `observedAt`, which is what the
stale-state rule measures against `asOf`.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PREFLIGHT_MAX_SNAPSHOT_AGE_SECONDS` | `120` | Snapshot older than this is blocking. |
| `PREFLIGHT_WARN_SNAPSHOT_AGE_SECONDS` | `60` | Snapshot older than this is a warning (clamped to the max). |
| `PREFLIGHT_MAX_ORACLE_AGE_SECONDS` | `60` | Oracle price older than this is blocking. |

## Design decisions and tradeoffs

- **Pure core, injected state.** The evaluator is decoupled from where state
  comes from. `PreflightStateProvider` is the seam: the default
  `DefaultPreflightStateProvider` is in-memory and deterministic, and it asks the
  existing `PolicyService` for the trading decision so the preflight and the
  policy engine can never disagree. A production deployment can bind a
  DB/chain-backed provider to the `PREFLIGHT_STATE_PROVIDER` token without
  changing a single rule.
- **Caller-supplied snapshots.** Requiring the caller to send the state it was
  prepared against makes the check reproducible — the same request yields the
  same verdict — and lets the rule set run without touching a database. The
  tradeoff is that a caller could under-report its own balance; the endpoint is
  therefore a guard against *known-invalid* operations, not an authorization
  boundary. Server-side state enrichment belongs in a custom provider.
- **Reuse over duplication.** Trading limits are not re-implemented: the state
  provider runs `PolicyService.evaluateTrade` and the core maps the resulting
  violation. Idempotency codes are aligned with
  `src/common/idempotency`, and oracle/expiry codes mirror
  `src/blockchain/oracle`.
- **Blocking vs. warning.** A rule blocks only when proceeding is known to be
  invalid (insufficient balance, expired, duplicate, stale oracle, policy
  violation). Conditions that are risky but recoverable (unverified destination,
  thin fee buffer, aging snapshot) warn instead, so the caller keeps agency.
- **No parallel module.** The preflight adds one module and does not repurpose
  `src/simulator` or `src/sandbox`; those solve different problems.

## Run the focused checks

```bash
npx jest src/preflight --runInBand
```

The suite covers a fully-successful evaluation, a non-blocking warning with
remediation, a blocking failure, a stale-snapshot result, and determinism
(identical input produces an identical result/digest, and input array ordering
is irrelevant). All I/O is mocked through a stub `PreflightStateProvider`.
