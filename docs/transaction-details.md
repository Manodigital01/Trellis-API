# Progressive transaction details

Issue: [#125](https://github.com/TRELLIS-STELLAR/Trellis-API/issues/125)

A Stellar transaction carries a lot of information: on-chain identifiers, the
audit trail, amount precision, the raw Horizon payload. Clients that need none
of it paid for it in payload size, and clients that needed it had to screen
scrape a flat response. This feature makes the depth of detail a parameter, and
keeps the risk visible at every level.

## Backwards compatibility

Omitting `details` returns the previous response, unchanged. Nothing migrates by
accident.

## Tiers

| Tier | What it adds |
| --- | --- |
| `summary` | Identity, settlement summary and risk signals. |
| `standard` | Adds the reconciliation audit trail. (Default inside the service.) |
| `advanced` | Adds amount precision, reference analysis and the raw payload. |

```bash
curl "$API/reconcile/stellar/tx/tx-1?details=advanced"
```

## Before submission

`dryRun=true` on the ingest endpoints projects the same view **without writing
anything**, so advanced detail and the warnings it produces are available before
a payment is committed:

```bash
curl -X POST "$API/reconcile/stellar/transactions?details=advanced&dryRun=true" \
  -H 'content-type: application/json' \
  -d '{"transactionId":"tx-1","destinationAccount":"G...","amount":"10.0","memo":"order-1"}'
```

The response adds a `preview` block:

```json
{
  "preview": {
    "dryRun": true,
    "persisted": false,
    "duplicate": false,
    "wouldCreate": true,
    "expandedSections": ["identity", "settlement", "risk", "raw_payload"]
  }
}
```

`duplicate` is true when the transaction id is already stored, which is the
answer to "what happens if this arrives twice".

## The disclosure block

```json
{
  "requestedTier": "standard",
  "effectiveTier": "standard",
  "availableTiers": ["summary", "standard", "advanced"],
  "sections": [
    {
      "id": "raw_payload",
      "label": "Raw Horizon payload",
      "summary": "The unmodified response from Horizon.",
      "risk": "internal",
      "state": "collapsed",
      "hint": "Request details=advanced to expand this section."
    }
  ],
  "hidden": [
    {
      "id": "amount_precision",
      "label": "Amount precision",
      "risk": "internal",
      "requiredTier": "advanced",
      "reason": "requires_advanced_tier"
    }
  ],
  "accessibility": {
    "disclosureModel": "progressive",
    "focusOrder": ["risk", "identity", "settlement", "..."],
    "alwaysVisibleSections": ["risk"]
  }
}
```

A section is `expanded`, `collapsed` or `hidden`. A collapsed section carries a
`hint` and **no data**, so a client cannot render a collapsed section by
accident. A hidden section is not rendered at all; `hidden[].reason` says why.

## Risk is never hidden

A section is `critical` or `internal`. Critical sections are always expanded, at
every tier, and can never appear in `hidden`. Warnings carry
`alwaysVisible: true` and include a `severity` and an `action`:

| Warning | Severity | Meaning |
| --- | --- | --- |
| `UNMATCHED_PAYMENT` | critical | No invoice matched; the payment is unaccounted for. |
| `TRANSACTION_FAILED` | critical | The payment failed; `message` carries the provider's reason. |
| `PARTIAL_PAYMENT` | warning | The invoice is underpaid. |
| `OVERPAYMENT` | warning | More was sent than the invoice expected. |
| `MISSING_DESTINATION` | warning | No invoice exists for the destination account. |
| `UNVERIFIED_REFERENCE` | warning | There is no memo, so the payment cannot be tied to an order. |
| `INVARIANT_VIOLATION` | critical | The projection detected an internal inconsistency. |

The set of critical warnings is identical at every tier: a client cannot widen
its view and lose a warning.

## Accessibility

`assertDisclosureInvariants` fails the build of any projection that breaks the
contract, so these are enforced rather than documented:

- Every section has a non-empty `label` and `summary` for assistive technology.
- Critical sections are expanded and never listed in `hidden`.
- Collapsed sections carry no data.
- Warnings marked critical have `alwaysVisible: true`.
- `accessibility.focusOrder` starts with the critical sections, so a keyboard or
  screen-reader user reaches the risk before the detail.

## Reading the code

- `src/common/transaction-details/transaction-detail.projection.ts` — tiers,
  states, invariants.
- `src/reconciliation/transaction-details.service.ts` — builds the sections and
  the warnings for a transaction.
- `src/reconciliation/reconciliation.controller.ts` — `details` and `dryRun`
  query parameters.
