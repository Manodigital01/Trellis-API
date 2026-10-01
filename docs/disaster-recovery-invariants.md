# Disaster Recovery Domain Invariants Validation Guide

## 1. Overview

Following a database restore, disaster recovery switchover, or major data migration, maintainers must verify that core domain entities, cryptographic proofs, on-chain settlement references, and relational links remain strictly consistent.

The Disaster Recovery (DR) Validation system provides automated, **read-only** verification across all Trellis API subsystems.

---

## 2. Invariant Definitions by Subsystem

### 2.1 Authentication & Identity
- **`AUTH_ORPHANED_WALLETS` (CRITICAL)**: Every wallet record must reference a valid, existing user in `users`.
- **`AUTH_STELLAR_KEY_FORMAT` (ERROR)**: Stellar wallet addresses must strictly match RFC4648 Base32 ed25519 public key format (`^G[A-Z2-7]{55}$`).
- **`AUTH_DUPLICATE_WALLETS` (ERROR)**: The same active wallet public key must not be linked across distinct user accounts.
- **`AUTH_ORPHANED_PROFILES` (WARNING)**: Profile records must link to valid user records.

### 2.2 Portfolio & Investment
- **`PORTFOLIO_ORPHANED_ASSETS` (CRITICAL)**: Every asset row in `portfolio_assets` must belong to a valid portfolio in `portfolios`.
- **`PORTFOLIO_ORPHANED_TRANSACTIONS` (ERROR)**: Transaction history referencing a `portfolioId` must have a corresponding portfolio record.
- **`PORTFOLIO_VALUATION_CONSISTENCY` (WARNING)**: Stored `totalValue` on active portfolios must match the aggregate sum of asset holdings (`SUM(amount * currentPrice)`), within a $0.05 rounding threshold.
- **`PORTFOLIO_ALLOCATION_RANGE` (ERROR)**: Holdings amounts must be non-negative (`amount >= 0`) and target allocations must fall between `0.00%` and `100.00%`.
- **`PORTFOLIO_TARGET_OVERSUBSCRIPTION` (WARNING)**: The sum of asset target percentages for any single portfolio must not exceed `100.01%`.

### 2.3 Blockchain & Oracle
- **`ORACLE_DUPLICATE_PRICE_RECORDS` (WARNING)**: Prevents duplicate price feed snapshots for the identical asset pair, source account, and timestamp.
- **`ORACLE_MALFORMED_SIGNED_PAYLOADS` (CRITICAL)**: Signed payloads submitted to Soroban contracts must have a non-null payload hash and valid signature.
- **`ORACLE_SUBMISSION_INTEGRITY` (ERROR)**: Oracle submissions marked as `submitted` must possess a valid settlement `txHash`.

### 2.4 Reconciliation & Settlement
- **`RECONCILIATION_ORPHANED_AUDITS` (ERROR)**: Audit logs must link to a valid `StellarTransaction` record.
- **`RECONCILIATION_INVOICE_SETTLEMENT_CONSISTENCY` (CRITICAL)**: Invoices marked as `SETTLED` must have `paidAmount >= expectedAmount`.
- **`RECONCILIATION_STELLAR_TX_HASH_FORMAT` (ERROR)**: Stellar transaction IDs must be 64-character hexadecimal SHA-256 hashes (`^[a-fA-F0-9]{64}$`).

### 2.5 DeFi & Positions
- **`DEFI_ORPHANED_POSITIONS` (CRITICAL)**: All open DeFi positions must belong to a valid user account.

### 2.6 Notifications & Audit Provenance
- **`NOTIFICATIONS_ORPHANED_RECORDS` (WARNING)**: In-app notifications must reference valid user accounts.
- **`GROWTH_ORPHANED_ALERTS` (WARNING)**: Alert subscriptions must belong to valid users.
- **`AUDIT_PROVENANCE_HASH_INTEGRITY` (ERROR)**: AI compute provenance records must include immutable `inputHash` and `outputHash`.

---

## 3. Running Validation

### CLI Execution
The validation script is strictly **read-only** by default and produces zero mutations or side-effects:

```bash
# Human-readable table report
npm run dr:validate

# Machine-readable JSON output (for automated health checks / CI)
npm run dr:validate -- --json
```

### Exit Codes
- `0`: All invariants consistent (or only non-blocking warnings detected).
- `1`: One or more `CRITICAL` or `ERROR` invariants failed.

---

## 4. Failure Interpretation and Escalation

| Severity | Impact | Maintainer Action | Escalation SLA |
| :--- | :--- | :--- | :--- |
| **`CRITICAL`** | Direct financial, custody, or state corruption risk (e.g. orphaned assets, settled invoices with insufficient payment). | **Halt live trading & settlement queues.** Initiate root-cause investigation and restore/reconciliation fix. | **P0 Immediate (<15 mins)** |
| **`ERROR`** | Malformed data, broken audit trails, or non-conforming transaction hashes. | Inspect affected rows via the sample output; apply data reconciliation patch or replay missing events. | **P1 Urgent (<2 hours)** |
| **`WARNING`** | Minor valuation drift or dangling metadata/notification rows. | Queue background cleanup or portfolio re-valuation task. | **P2 Normal (<24 hours)** |

---

## 5. Recovery Assumptions
1. PostgreSQL database connection is operational and migrations are up-to-date.
2. The database user has `SELECT` privileges across all schema tables.
3. Invariant checks execute in O(1) memory space through SQL aggregate queries.
