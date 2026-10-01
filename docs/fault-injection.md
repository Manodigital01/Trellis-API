# Fault injection

Issue: [#127](https://github.com/TRELLIS-STELLAR/Trellis-API/issues/127)

Happy-path tests confirm the code does what it should when nothing goes wrong.
This suite covers the other half: Horizon timing out, an RPC node rejecting a
signature, a database that accepts half a write. The properties that matter are
not "it threw" but **what is left behind afterwards**.

```bash
npm run test:faults
```

## The harness

`src/testing/fault-injection/fault-injection.ts` is deliberately small and has no
framework magic.

### `FaultController`

Scripts what a collaborator does next. Faults are consumed in order, so a test
states the whole failure sequence up front and the run is reproducible.

```ts
const horizon = new FaultController("Horizon");
horizon.queueTimeout();                       // fires once, then behaves
horizon.queueHttpStatus(503, times: 3);      // fails three times, then recovers
horizon.queueMalformedBody();                // body that is not valid JSON
horizon.queueFault({ kind: "partial-write", onCall: 2 });
```

`unconsumed()` reports faults that never fired, so a test cannot pass because
its script was wrong.

Each repository gets its own controller, which is what makes `onCall: 2` mean
"the second save on *this* table" instead of "the second call anywhere".

### `createFaultyFetch`

A `fetch` that fails where the test says. Returns the default body when no fault
applies, so a test only scripts the interesting call. Malformed responses are
modelled as a body whose `json()` rejects, which is what production sees.

### `FaultyRepository`

A repository double with a visible `rows` table, so a test asserts on what
**survived** the failure rather than on what the code hoped to save. It can:

- accept part of a write and then fail, leaving the keys the database managed to
  write before the connection dropped;
- reject a write outright (unique or foreign key violation);
- fail a `findOne`, which is how a broken read shows up.

### `SideEffectLedger`

Records everything that cannot be undone by retrying — on-chain submissions,
payments, emails, webhooks, committed rows.

```ts
expect(() => ledger.assertNoDuplicates()).not.toThrow();
```

A payment that happens twice is an incident, not a retry, so the ledger fails
with a message naming the effect, the key and the count.

### `ManualClock`

Retry backoff is asserted in virtual time. A `sleep` only resolves when the test
advances the clock, so a suite that covers a 60-second backoff still finishes in
milliseconds and never flakes on a loaded machine.

## Fault kinds

`timeout`, `connection-reset`, `network-unreachable`, `http-status`,
`malformed-body`, `malformed-payload`, `partial-write`,
`constraint-violation`, `wallet-unavailable`, `insufficient-funds`,
`nonce-too-low`, `execution-reverted`.

Each maps to a message that names the collaborator, the attempt and what to do
next, and to a retry decision: infrastructure faults are retryable, chain
rejections are not.

## What the suite asserts

`src/reconciliation/reconciliation.faults.spec.ts`:

- A Horizon timeout writes a `RETRY` audit with an actionable reason and stores
  nothing, so a later poll can safely repeat the work.
- A body of the wrong shape is refused rather than treated as an empty account.
  Silently skipping a page of payments is worse than a failed poll.
- A broken transaction write leaves the invoice untouched and writes no audit.
- A half-written audit row stays visible, and the transaction is marked `FAILED`
  with the reason the database gave.
- Re-ingesting the same transaction, or retrying after the final write failed,
  applies the payment exactly once.

`src/blockchain/oracle/services/submitter.faults.spec.ts`:

- A confirmed or already-submitted payload is never submitted again: the
  recorded hash is returned instead.
- A failed confirmation lookup does not trigger a second submission.
- A permanent wallet rejection (insufficient funds, execution reverted) is not
  retried.
- A transient timeout is retried within the configured budget, then recorded as
  `FAILED` with the provider's message.
- A failed gas estimation falls back to the default limit and still submits.

## Isolation

- No test opens a socket. `global.fetch` is replaced and restored; the ethers
  provider, wallet and contract that `SubmitterService` builds from configuration
  are swapped for scripted doubles.
- No test waits on wall-clock time: backoff is configured in single-digit
  milliseconds, or driven by `ManualClock`.
- Every controller, repository and ledger is created in `beforeEach`, so state
  cannot leak between tests.
- The doubles are in `src/testing/`, not in production code paths, and are never
  imported by `src/`.

## Known gaps

- **Ambiguous submission.** If the node accepts a transaction and the response
  is lost, `submitPayload` reports a timeout and the retry loop sends a second
  transaction. The nonce-based recovery in `categorizeFailure` treats "nonce too
  low" as permanent, so the *second* submission fails rather than paying twice,
  but the attempt is still made. Guarding this properly means recording the
  attempt before sending and reconciling by nonce; the suite documents the
  current behaviour rather than hiding it.
- **Gas estimation failures are silent.** A revert during estimation is logged
  and replaced with a default limit, so a payload can be submitted with a gas
  limit nobody verified.
- **Monitoring failures mark the payload `FAILED`.** A receipt lookup that times
  out leaves a transaction that may still confirm, and the row says `FAILED`. An
  operator has to reconcile it; the suite pins the current behaviour so a future
  change is deliberate.
