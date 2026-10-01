# Trellis API Domain Invariants

This document specifies the core domain invariants enforced across the Trellis API. These invariants safeguard domain model consistency, preventing impossible ownership, balance, transaction, access, or lifecycle states across API routes, workers, and on-chain interactions.

---

## Invariant Catalog

### 1. Portfolio Asset Weight Sum Unity
- **Rule**: $\sum_{i=1}^n w_i = 1.0$ (within $\pm 0.0001$ float tolerance) and $0 \le w_i \le 1.0$ for all $i$.
- **Why It Matters**: Prevents over-allocated or under-allocated portfolios during target rebalancing, which would distort risk attribution and trade size calculations.
- **Relevant Code Paths**:
  - `src/investment/portfolio/entities/portfolio.entity.ts`
  - `src/investment/portfolio/services/portfolio.service.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertPortfolioAssetWeightSum`)

---

### 2. Non-Negative Balance and Quantity
- **Rule**: $B_{\text{cash}} \ge 0$ and $Q_{\text{asset}} \ge 0$.
- **Why It Matters**: Prevents artificial fractional reserve or negative asset quantities from corrupting off-chain ledgers and user portfolio valuation.
- **Relevant Code Paths**:
  - `src/investment/portfolio/entities/portfolio-asset.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertNonNegativeBalance`)

---

### 3. Transaction Immutability Post-Confirmation
- **Rule**: For transactions in terminal state (`CONFIRMED`, `SETTLED`, `FAILED`), fields `txHash`, `ledgerSequence`, `amount`, `sourceAccount`, and `destinationAccount` are strictly immutable.
- **Why It Matters**: Protects reconciliation audits and transaction history against tamper attacks, race conditions, or accidental overwrites.
- **Relevant Code Paths**:
  - `src/reconciliation/entities/stellar-transaction.entity.ts`
  - `src/investment/portfolio/entities/transaction.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertTransactionImmutability`)

---

### 4. Valid Portfolio Lifecycle State Transitions
- **Rule**: State transitions must strictly follow the authorized DAG:
  - `DRAFT` $\to$ `ACTIVE` | `ARCHIVED`
  - `ACTIVE` $\to$ `REBALANCING` | `PAUSED` | `ARCHIVED`
  - `REBALANCING` $\to$ `ACTIVE` | `FAILED`
  - `PAUSED` $\to$ `ACTIVE` | `ARCHIVED`
  - `FAILED` $\to$ `ACTIVE` | `ARCHIVED`
  - `ARCHIVED` is terminal (cannot transition out).
- **Why It Matters**: Prevents archived portfolios from being executed on-chain, and prevents un-initialized draft portfolios from triggering automated rebalancing workers.
- **Relevant Code Paths**:
  - `src/investment/portfolio/entities/portfolio.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertValidPortfolioLifecycleTransition`)

---

### 5. Ownership and Multi-Tenant Isolation
- **Rule**: Entities must possess a non-null owner ID. Mutations must be performed by the verified owner or superadmin; cross-tenant mutation is strictly blocked ($T_{\text{entity}} = T_{\text{actor}}$).
- **Why It Matters**: Enforces zero-trust isolation in multi-tenant environments, preventing unauthorized cross-tenant data access or asset manipulation.
- **Relevant Code Paths**:
  - `src/core/auth/guards/`
  - `src/core/user/entities/user.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertOwnershipAndTenantIsolation`)

---

### 6. Risk Profile Tolerance Consistency
- **Rule**: $0 < \text{maxDrawdown} \le 1.0$, $\text{volatilityTolerance} > 0$, and $0.80 \le \text{varConfidence} < 1.0$.
- **Why It Matters**: Bounds portfolio optimization and stop-loss automation to valid statistical intervals, avoiding division by zero or nonsensical drawdown limits.
- **Relevant Code Paths**:
  - `src/investment/portfolio/entities/risk-profile.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertRiskProfileToleranceBounds`)

---

### 7. Rebalancing Event Value Conservation
- **Rule**: $|V_{\text{pre}} - (V_{\text{post}} + \text{Fees})| \le V_{\text{pre}} \times \text{MaxSlippagePct}$.
- **Why It Matters**: Detects fund leakages, extreme slippage, or front-running during automated portfolio swaps and multi-asset rebalancing.
- **Relevant Code Paths**:
  - `src/investment/portfolio/entities/rebalancing-event.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertRebalancingConservation`)

---

### 8. Stellar Public Key and Contract Identifier Formatting
- **Rule**: 56-character RFC 4648 Base32 string starting with `'G'` for accounts or `'C'` for Soroban contracts.
- **Why It Matters**: Halts malformed keys at the domain layer before submitting transactions to Horizon or Soroban RPC nodes.
- **Relevant Code Paths**:
  - `src/core/auth/entities/wallet.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertStellarAddressFormat`)

---

### 9. Audit Trail Completeness & Temporal Monotonicity
- **Rule**: Audited mutations must supply a non-empty `entityId`, `actorId`, `newStateHash`, and non-future timestamp ($t_{\text{entry}} \le t_{\text{now}} + 5\text{s}$).
- **Why It Matters**: Guarantees forensic audit log integrity and provenance chain continuity.
- **Relevant Code Paths**:
  - `src/infrastructure/audit/entities/audit-log.entity.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertAuditTrailIntegrity`)

---

### 10. Module Registry Lifecycle & Version Compatibility
- **Rule**: Deprecated modules cannot be enabled for any tenant, and module dependencies must satisfy the host core compatibility range.
- **Why It Matters**: Prevents broken or superseded plugin modules from executing in production tenant contexts.
- **Relevant Code Paths**:
  - `src/migrations/1787313600000-create-module-registry.ts`
  - `src/common/invariants/domain-invariants.ts` (`assertModuleCompatibility`)
