# Integration Sandbox Mode

Sandbox mode lets contributors run the **primary Trellis payment workflow**
(`create → sign → submit → status → refund`) locally against deterministic fake
adapters — no production credentials, no real wallets, no network calls, and no
irreversible records.

It is opt-in via `SANDBOX_MODE=true` and is **refused when
`NODE_ENV=production`**.

---

## What is sandboxed

| External dependency | Sandbox stand-in |
| --- | --- |
| Payment / chain backend (Stellar Horizon, Grantfox) | `SandboxPaymentAdapter` — implements the same `IPaymentProcessor` contract, serves canned fixtures |
| Ids and transaction hashes | Seeded SHA-256 — the same request always returns the same value |
| Failure modes | Named fixtures for success, failed payment, insufficient funds and a transient timeout |

The payment-processor plugin system is the seam: the sandbox adapter is
registered in the shared `PaymentProcessorRegistry` **only while sandbox mode is
on** (see `SandboxProcessorRegistrar`). Production never lists or routes to it.

---

## Quick start

```bash
# 1. Install deps (once)
npm install

# 2. Run the sandbox workflow demo — needs no .env and no credentials
npm run sandbox:demo

# 3. Run the sandbox test suite
npm test -- src/sandbox
```

`npm run sandbox:demo` runs the full lifecycle and prints a JSON trace for the
`success`, `insufficient_funds` and `horizon_timeout` scenarios. It does not
boot the Nest app, so it does not need PostgreSQL, Redis or any secret.

### Enabling sandbox mode for the API

Add to your local `.env`:

```dotenv
SANDBOX_MODE=true
# Optional: default scenario and the seed that makes ids reproducible
SANDBOX_SCENARIO=success
SANDBOX_SEED=trellis-local-sandbox
```

Then start the server and pin the processor per request:

```bash
npm run start:dev

curl -X POST http://localhost:3000/api/v1/payments \
  -H 'Authorization: Bearer <jwt>' \
  -H 'X-Payment-Processor: sandbox' \
  -H 'Content-Type: application/json' \
  -d '{"amount":"10","currency":"XLM","destination":"GBSANDBOX","idempotencyKey":"sandbox-1"}'
```

You can also set `PAYMENTS_DEFAULT_PROCESSOR=sandbox`. The sandbox processor is
never selected implicitly while other processors are enabled — select it
explicitly so it can never be reached by accident.

---

## Configuration

All variables are optional and validated in `src/config/env.validation.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANDBOX_MODE` | `false` | Master switch. Must be exactly `true` to enable. |
| `SANDBOX_SCENARIO` | `success` | Fixture used when a request does not name one. |
| `SANDBOX_SEED` | `trellis-local-sandbox` | Seed for all generated ids/hashes. Change it to get a fresh id space. |

A request can override the scenario per call with
`metadata.sandboxScenario` on `POST /payments`.

### Scenarios

| Scenario | Fails at | Behaviour |
| --- | --- | --- |
| `success` | — | `CONFIRMED` on submit, full `REFUNDED` refund. |
| `payment_failed` | `refund` | Submission settles `FAILED`; refunding raises `400`. |
| `insufficient_funds` | `create` | Creation raises `400` with a fixed balance message. |
| `horizon_timeout` | `submit` | Submission raises a retryable `503`. |

Fixtures live in `src/sandbox/fixtures/sandbox.fixtures.ts` and are the single
place to add a new scenario.

---

## Determinism guarantees

* Every id, payload and hash is derived from `SANDBOX_SEED` plus stable request
  fields (scenario, idempotency key, payment id) via SHA-256.
* Calling any sandbox method twice with the same input returns the same value.
* Sandbox ids are prefixed `sbx:<scenario>:<kind>:<hex>` so they are obviously
  fake and can never be mistaken for a Stellar hash or a UUID. They must never
  be sent to a real network.
* The scenario travels inside the unsigned/signed payloads, so the stateless
  create → sign → submit HTTP flow keeps its scenario across requests, exactly
  like a real XDR round-trips.

`src/sandbox/adapters/sandbox-payment.adapter.spec.ts` asserts determinism, the
full lifecycle, every failure scenario, and that the adapter works with **only**
`SANDBOX_MODE` set.

---

## Limitations

* Sandbox mode covers the **payment workflow only**. Booting the full API still
  requires `DATABASE_URL`, `JWT_SECRET` and `REDIS_URL`; the sandbox demo and
  tests are intentionally standalone and need none of them.
* Fixture state is in-memory and resets on restart; nothing is persisted and no
  ledger record is ever written.
* The sandbox processor is registered only while `SANDBOX_MODE=true`, and never
  when `NODE_ENV=production`. Every adapter entry point also fails closed with
  `412 Precondition Failed` if the flag is missing.
* This is **not** a replacement for the real-network suite. Use
  `npm run test:testnet` when you need to validate against Stellar testnet.
* Sandbox ids are not valid ledger hashes by design; do not assert on their
  shape beyond the `sbx:` prefix.

---

## Adding a scenario

1. Add the value to `SandboxScenario` in `src/sandbox/sandbox.scenarios.ts`.
2. Add the matching fixture entry to `SANDBOX_FIXTURES` in
   `src/sandbox/fixtures/sandbox.fixtures.ts`.
3. Cover it in `src/sandbox/adapters/sandbox-payment.adapter.spec.ts`.

No adapter code changes are needed — the adapter is a thin interpreter over the
fixture table.
