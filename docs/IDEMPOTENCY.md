# Idempotency and replay protection

High-risk write endpoints (payments, withdrawals, reconciliation overrides,
maintainer actions) must be safe to retry. Network timeouts, mobile clients, and
upstream gateways routinely re-send the exact same request; without a guard the
API happily performs the side effect twice.

`IdempotencyModule` adds server-side replay protection for every mutating
request (`POST`, `PUT`, `PATCH`, `DELETE`).

## How it works

```
client ──▶ POST /payments  (Idempotency-Key: order-0001-attempt)
                │
                ▼
     IdempotencyInterceptor
                │  lookup (scope, key)
        ┌───────┴────────────────────────────────────────────┐
        │ no record        → run handler, store response      │
        │ completed        → replay stored status + body      │
        │ in progress      → 409 Conflict                     │
        │ different payload→ 409 Conflict                     │
        │ failed / expired → run handler again                │
        └─────────────────────────────────────────────────────┘
```

Every response carries `Idempotency-Replayed: true|false` so clients (and
support engineers reading logs) can tell a replay from a fresh execution.

### Scope

A key is never global. Records are scoped as:

```
SCOPE = METHOD:/route:actor
```

so the same client-generated value on `/payments` and `/withdrawals`, or for
two different users, cannot collide or leak a cached response across tenants.

### Payload binding

The stored `requestHash` is a SHA-256 of a canonicalized JSON of
`{ params, query, body }` (object keys sorted, so key order does not matter).
Reusing a key with a different payload is rejected with **409** instead of
silently returning the wrong cached response.

### Failure handling

Failures are recorded as `failed` and are **not** cached — the marker is
dropped on the next attempt so a client retry can make progress. Only completed
responses are replayed, and only for `ttlSeconds`.

### Concurrency

`(scope, idempotencyKey)` is a unique index. Two racing requests with the same
key cannot both execute; the loser is rejected with **409** ("already in
progress") and the client can retry once the first request settles.

## Usage

The interceptor is global, so endpoints are protected as soon as the module is
imported:

```ts
import { IdempotencyModule } from "./common/idempotency/idempotency.module";

@Module({ imports: [IdempotencyModule, /* ... */] })
export class AppModule {}
```

Make the key mandatory for a specific high-risk route:

```ts
import { Idempotent } from "../common/idempotency/idempotency.decorator";

@Post("withdrawals")
@Idempotent({ required: true, ttlSeconds: 3600 })
initiateWithdrawal(@Body() dto: CreateWithdrawalDto) {
  // ...
}
```

`@Idempotent({ required: true })` returns **400** when the header is missing, on
top of the global replay protection.

### Request example

```bash
curl -X POST https://api.trellis.example/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-0001-attempt" \
  -d '{"invoiceId":"INV-2026-0001","amount":"10.0000000"}'
```

Retrying with the same key and body returns the original response with
`Idempotency-Replayed: true` and does not create a second payment.

## Key requirements

| Rule | Value |
| --- | --- |
| Header | `Idempotency-Key` |
| Length | 8–128 characters |
| Charset | letters, digits, `. _ : + -` |
| Recommended source | a client-side UUID, one per logical user action (not per attempt) |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | How long a completed response stays replayable (capped at 7 days). |

## Maintenance

`IdempotencyService.purgeExpired()` removes records past their TTL and can be
called from a scheduler or an ops task:

```ts
await idempotencyService.purgeExpired();
```

`IdempotencyService` is exported from `IdempotencyModule` for services that
need to protect a non-HTTP side effect (queues, workers, cron jobs) with the
same guarantees.
