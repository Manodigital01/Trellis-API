# Trellis Typed Integration Contract

> Resolves issue #120 — typed client contract for cross-repo Trellis integrations.

## Overview

`src/common/contract/types/trellis-contract.types.ts` is the **single source of
truth** for shapes exchanged between the Trellis API, frontend, and
contract-facing code.

## Key types

| Type / Enum | Purpose |
|---|---|
| `OperationStatus` | Wire-stable status values used across all operations |
| `OperationType` | Discriminator for every operation kind on the platform |
| `OperationReceipt` | Common response envelope for any async operation |
| `OperationErrorDetail` | Structured error detail inside a receipt |
| `RecoveryEntry` / `RecoveryAction` | Recovery center contract (issue #122) |
| `RateLimitInfo` / `RateLimitExceededResponse` | Rate-limit header/response contract (issue #121) |
| `SnapshotSummary` / `SnapshotVerification` | Snapshot contract (issue #119) |
| `ApiEnvelope<T>` | Standard response wrapper |
| `CursorPage<T>` | Pagination contract |
| `ApiErrorResponse` | Structured error shape |
| `AuthToken` | JWT auth response |
| `CONTRACT_VERSION` | Semver string — bump on changes (see below) |

## Updating the contract safely

1. **Non-breaking (new optional field, new enum value)** — add it, bump `MINOR` in `CONTRACT_VERSION`, update `trellis-contract.spec.ts`.
2. **Breaking (rename, remove, type change)** — bump `MAJOR`, add a migration note in `CHANGELOG.md`, coordinate with consumer repos before merging.
3. Run `npm test src/common/contract` to verify all shape and enum invariants pass before opening a PR.

## Detecting drift

The contract test file `trellis-contract.spec.ts` enforces:
- All enum values remain stable (no silent renames).
- All required fields are present on core shapes.
- `CONTRACT_VERSION` follows semver.

CI will fail if any invariant is violated.
