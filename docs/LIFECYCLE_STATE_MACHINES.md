# Deterministic Lifecycle State Machines

## Overview

Issue **#25** implements a unified, deterministic lifecycle state machine engine for core domain records in the Trellis API. This eliminates implicit inferences from scattered booleans (such as `isActive`, `emailVerified`, `deletedAt`), ad-hoc string comparisons, and divergent UI/API assumptions.

All core records now follow explicit lifecycle states with guarded transitions, terminal state invariants, durable audit event logging, and consistent error contracts.

---

## Architecture & Core Components

The state machine subsystem is located in `src/common/lifecycle/` and includes:

1. **`DeterministicStateMachine<TState, TContext>`** (`deterministic-state-machine.ts`):
   - Fast, indexed transition lookup ($O(1)$).
   - Enforces valid transition paths, evaluates transition guards (sync or async), and prevents escapes from terminal states.
   - Idempotent self-transitions (transitioning from state $S$ to $S$ is allowed as a no-op).
   - Derives UI/API state models (`StateDerivedModel`) exposing current state, terminal status, allowed transitions, and metadata.

2. **`InvalidStateTransitionException`** (`invalid-state-transition.exception.ts`):
   - Standardized NestJS `BadRequestException` (HTTP 400).
   - Returns structured, machine-readable payloads with `stateMachine`, `resourceType`, `resourceId`, `currentState`, `attemptedState`, `allowedTransitions`, and `reason`.

3. **`RecordStateMachines`** (`record-state-machines.ts`):
   - Pre-configured, type-safe definitions for all core domain records:
     - `PortfolioStateMachine`
     - `TransactionStateMachine`
     - `DeFiPositionStateMachine`
     - `UserStateMachine`
     - `InvitationStateMachine`
     - `PaymentOperationStateMachine`
   - Canonical state derivation functions (`derivePortfolioLifecycleState`, `deriveUserLifecycleState`) ensuring legacy and persisted records cleanly map to deterministic states.

4. **`LifecycleService`** (`lifecycle.service.ts`):
   - High-level orchestration service providing guarded transitions with automated sensitive action audit logging (`SensitiveActionAuditService`) and event emitter integration (`EventEmitter2`).

5. **`LifecycleModule`** (`lifecycle.module.ts`):
   - Global NestJS module exporting `LifecycleService`.

---

## Core Domain State Machines

### 1. Portfolio Lifecycle (`PortfolioStateMachine`)

| State | Display Name | Terminal | Mutating Locked | Description |
|---|---|---|---|---|
| `draft` | Draft | No | No | Initial portfolio draft configuration before activation |
| `active` | Active | No | No | Fully operational portfolio accepting rebalances and trades |
| `rebalancing` | Rebalancing | No | No | Optimization or automated rebalancing execution in progress |
| `paused` | Paused | No | No | User-paused; automated rebalancing and order execution suspended |
| `frozen` | Frozen | No | Yes | Risk circuit-breaker tripped; transactions restricted |
| `archived` | Archived | **Yes** | **Yes** | Permanently deactivated and soft-deleted |

#### Legal Transitions
- `draft` $\rightarrow$ `active`, `archived`
- `active` $\rightarrow$ `rebalancing`, `paused`, `frozen`, `archived`
- `rebalancing` $\rightarrow$ `active`, `paused`, `frozen`
- `paused` $\rightarrow$ `active`, `archived`
- `frozen` $\rightarrow$ `active` *(requires override/reason)*, `archived`
- `archived` $\rightarrow$ *None (Terminal)*

---

### 2. Transaction Lifecycle (`TransactionStateMachine`)

| State | Display Name | Terminal | Description |
|---|---|---|---|
| `pending` | Pending | No | Transaction prepared and awaiting signing/submission |
| `submitted` | Submitted | No | Broadcast to Stellar/EVM network, awaiting block inclusion |
| `confirmed` | Confirmed | **Yes** | On-chain finality achieved and ledger reconciled |
| `failed` | Failed | **Yes** | Node rejected or preflight simulation failed |
| `cancelled` | Cancelled | **Yes** | Cancelled prior to network broadcast |
| `timed_out` | Timed Out | **Yes** | Inclusion deadline exceeded before confirmation |
| `reverted` | Reverted | **Yes** | Smart contract transaction reverted on-chain |

#### Legal Transitions
- `pending` $\rightarrow$ `submitted`, `cancelled`, `failed`
- `submitted` $\rightarrow$ `confirmed`, `failed`, `timed_out`, `reverted`
- `confirmed` / `failed` / `cancelled` / `timed_out` / `reverted` $\rightarrow$ *None (Terminal)*

---

### 3. DeFi Position Lifecycle (`DeFiPositionStateMachine`)

| State | Display Name | Terminal | Description |
|---|---|---|---|
| `active` | Active | No | Position is active and accruing yield or collateral |
| `paused` | Paused | No | Interactions temporarily suspended by user or protocol |
| `liquidation_risk` | Liquidation Risk | No | Health factor near or below liquidation threshold |
| `closed` | Closed | **Yes** | Position voluntarily unwound or withdrawn |
| `liquidated` | Liquidated | **Yes** | Involuntary liquidation executed |

#### Legal Transitions
- `active` $\rightarrow$ `paused`, `liquidation_risk`, `closed`
- `paused` $\rightarrow$ `active`, `closed`
- `liquidation_risk` $\rightarrow$ `active`, `liquidated`, `closed`
- `closed` / `liquidated` $\rightarrow$ *None (Terminal)*

---

### 4. User Lifecycle (`UserStateMachine`)

| State | Display Name | Terminal | Locked | Description |
|---|---|---|---|---|
| `pending_verification` | Pending Verification | No | No | Registered but awaiting email / KYC / wallet verification |
| `active` | Active | No | No | Verified and in good standing |
| `suspended` | Suspended | No | Yes | Administrative or policy compliance suspension |
| `locked` | Locked | No | Yes | Security lockout due to failed authentications |
| `deactivated` | Deactivated | No | Yes | Voluntary user deactivation |
| `archived` | Archived | **Yes** | **Yes** | Permanent erasure / GDPR deletion |

#### Legal Transitions
- `pending_verification` $\rightarrow$ `active`, `suspended`, `deactivated`, `archived`
- `active` $\rightarrow$ `suspended`, `locked`, `deactivated`, `archived`
- `suspended` $\rightarrow$ `active`, `archived`
- `locked` $\rightarrow$ `active`, `suspended`, `archived`
- `deactivated` $\rightarrow$ `active`, `archived`
- `archived` $\rightarrow$ *None (Terminal)*

---

### 5. Invitation Lifecycle (`InvitationStateMachine`)

| State | Display Name | Terminal | Description |
|---|---|---|---|
| `PENDING` | Pending | No | Invitation issued and awaiting acceptance |
| `ACCEPTED` | Accepted | **Yes** | Successfully accepted by recipient |
| `REVOKED` | Revoked | **Yes** | Cancelled by sender or admin |
| `EXPIRED` | Expired | **Yes** | Exceeded expiration time limit |

---

### 6. Payment Operation Lifecycle (`PaymentOperationStateMachine`)

| State | Display Name | Terminal | Description |
|---|---|---|---|
| `CREATING` | Creating | No | Operation record being assembled |
| `CREATED` | Created | No | Assembled and ready for cryptographic signing |
| `SIGNED` | Signed | No | Cryptographically signed payload ready for submission |
| `SUBMITTING` | Submitting | No | In-flight network submission |
| `SUBMITTED` | Submitted | **Yes** | Confirmed submitted to payment gateway or ledger |
| `RECOVERY_REQUIRED` | Recovery Required | No | Interrupted or ambiguous submission requiring reconciliation |

---

## API Endpoints & Contracts

### State Transition Endpoint
Transitions can be executed via:
- `POST /portfolio/portfolios/:id/transition`
- `POST /portfolio/:id/transition`

#### Request Payload (`TransitionPortfolioStateDto`)
```json
{
  "targetState": "paused",
  "reason": "Temporary maintenance pause requested by user"
}
```

#### Success Response (`200 OK`)
```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "name": "DeFi Growth",
  "status": "paused",
  "lifecycleState": "paused",
  "isTerminal": false,
  "allowedTransitions": ["active", "archived"],
  "totalValue": 10500.25,
  "createdAt": "2026-09-30T10:00:00.000Z",
  "updatedAt": "2026-09-30T20:45:00.000Z"
}
```

#### Error Response on Invalid Transition (`400 Bad Request`)
```json
{
  "statusCode": 400,
  "error": "InvalidStateTransition",
  "message": "Invalid lifecycle transition for portfolio [7c9e6679-7425-40de-944b-e07fc1f90ae7]: cannot transition from 'archived' to 'active'. Allowed transitions: []",
  "stateMachine": "Portfolio",
  "resourceType": "portfolio",
  "resourceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "currentState": "archived",
  "attemptedState": "active",
  "allowedTransitions": [],
  "reason": "State \"archived\" is terminal and cannot transition to any other state"
}
```

---

## Audit Trail & Event Integration

State transitions that impact financial assets or security boundaries automatically produce durable records:
1. **`SensitiveActionAuditService`**:
   - `SensitiveAction.PORTFOLIO_RECORD_CHANGED`
   - `SensitiveAction.PORTFOLIO_STATE_TRANSITION`
   - `SensitiveAction.USER_SUSPENDED` / `USER_REACTIVATED` / `USER_DELETED`
   - Captures `actorId`, `actorType`, `resourceId`, `beforeState`, `afterState`, and `reason`.
2. **`EventEmitter2`**:
   - Emits `LifecycleEventType.CIRCUIT_BREAKER_TRIPPED` on transitions to `FROZEN`.

---

## Testing & Validation

Comprehensive automated unit and integration tests are available in `src/common/lifecycle/test/lifecycle-state-machines.spec.ts`:
- Covers every legal transition across all 6 domain state machines.
- Covers over 30 rejected invalid transitions with assertions on HTTP status, payload structure, and terminal state locks.
- Validates legacy backward compatibility derivations.
- Run tests via:
  ```bash
  npx jest src/common/lifecycle/test/lifecycle-state-machines.spec.ts
  npm run test:contract
  ```
