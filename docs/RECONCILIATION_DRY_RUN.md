# Reconciliation dry run

The reconciliation pipeline writes as it matches payments (`ReconciliationService`).
Operators need the opposite: a way to ask *"does the stored data still make
sense?"* without touching anything.

`DryRunReconciliationService` answers that. It loads a bounded window of
invoices and ingested Stellar transactions, derives what the stored records
*should* look like, and reports every difference with suggested repairs. It has
no write path at all.

## Where it runs

| Trigger | Notes |
| --- | --- |
| `POST /reconcile/stellar/admin/dry-run` | Admin-only (JWT + `RolesGuard` + `AdminTwoFactorGuard`), body options. |
| `GET /reconcile/stellar/admin/dry-run` | Same report via query parameters, for dashboards. |
| Daily cron at 04:00 | `scheduledDryRun()` logs a one-line summary; read-only, so it is safe on production. |

Nothing is mutated by any of them, which is what makes the job safe to run in
local development and CI-like environments against a seeded database.

## Report shape

```json
{
  "dryRun": true,
  "readOnly": true,
  "generatedAt": "2026-09-26T12:00:00.000Z",
  "durationMs": 42,
  "options": { "staleDays": 7, "limit": 500, "toleranceAmount": "0.0000001", "includeUserBalances": true },
  "totals": {
    "invoices": 12,
    "transactions": 15,
    "expectedAmount": "1250.0000000",
    "paidAmount": "1200.0000000",
    "matchedTransactions": 11,
    "unmatchedTransactions": 4
  },
  "counts": { "total": 3, "critical": 1, "warning": 2, "info": 0, "byType": { "missing_payment": 1 } },
  "invariants": [
    { "name": "paid_invoices_have_payments", "passed": false, "detail": "1 paid invoice(s) have no matching transaction." }
  ],
  "findings": [
    {
      "type": "missing_payment",
      "severity": "critical",
      "message": "Invoice INV-2026-0001 is marked paid but no transaction matches its destination, asset, and reference.",
      "suggestedAction": "Do not mark the invoice paid again. Locate the settlement in the ledger ...",
      "invoiceId": "INV-2026-0001",
      "expected": "100.0000000",
      "actual": "100.0000000"
    }
  ],
  "userBalanceSource": "unavailable"
}
```

## Drift the report detects

| Finding | Severity | Meaning |
| --- | --- | --- |
| `missing_payment` | critical | Invoice is `paid` but no transaction matches its destination, asset, and reference. |
| `amount_mismatch` | critical / warning | Matched transactions do not cover the paid amount, or the stored `paidAmount` differs from the derived total. |
| `overpayment` | warning | Matched transactions exceed the expected amount. |
| `status_mismatch` | warning | The stored status disagrees with the status derived from the matched transactions, or a non-unmatched transaction has no invoice. |
| `orphan_transaction` | warning | An unmatched transaction matches no invoice destination. |
| `duplicate_transaction` | warning | Two transactions share source, destination, amount, and reference — a likely double-credit. |
| `stale_unmatched_transaction` | warning | A transaction has stayed unmatched longer than `staleDays`. |
| `failed_transaction` | info | A previous reconciliation attempt failed and may be retried. |
| `user_balance_drift` | warning | A user-facing balance differs from the total derived from matched transactions. |

Every finding carries `suggestedAction` — repair guidance only. The job never
applies it; an operator (or a separate, reviewed migration) does.

## Invariants

The report also evaluates named invariants so a dashboard can alert on a single
boolean instead of parsing findings:

* `paid_invoices_have_payments`
* `stored_amounts_match_transactions`
* `invoice_status_matches_payments`
* `no_duplicate_payments`
* `totals_within_expected`
* `user_balances_match_ledger` — `skipped: true` when no balance provider is
  configured, so "not checked" is never mistaken for "verified".

## Comparing user-facing balances

The ledger/transaction side is always available from the database. The
user-facing side is pluggable:

```ts
import { USER_BALANCE_PROVIDER, UserBalanceProvider } from "./reconciliation/dry-run-reconciliation.service";

@Module({
  providers: [
    ReconciliationModule, // ...
    { provide: USER_BALANCE_PROVIDER, useClass: UserBalanceViewAdapter },
  ],
})
export class AppModule {}
```

```ts
export class UserBalanceViewAdapter implements UserBalanceProvider {
  async loadSnapshots(accounts: string[]): Promise<UserBalanceSnapshot[]> {
    // return the balance the user actually sees, per account + asset
  }
}
```

Without a provider the report still reconciles invoices against transactions and
sets `userBalanceSource: "unavailable"` instead of pretending the balance check
passed. A provider that throws degrades the same way and is logged.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `staleDays` | `7` | Age at which an unmatched transaction is reported as stale. |
| `limit` | `500` | Maximum invoices **and** transactions inspected (hard cap 1000). |
| `toleranceAmount` | `0.0000001` | Differences at or below this are treated as rounding noise (7-decimal amounts). |
| `includeUserBalances` | `true` | Set `false` to skip the balance provider entirely. |

## Tests

`dry-run-reconciliation.service.spec.ts` covers: a consistent dataset (no
findings), missing payment, over/under payment, invoice status drift, orphan
transactions, stale vs fresh unmatched transactions, duplicate payments, failed
transactions, user balance drift with a provider, the skipped-without-provider
path, tolerance handling, window capping, and — through repositories whose write
methods throw — that a dry run never mutates anything.
