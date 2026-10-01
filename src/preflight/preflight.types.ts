import { ErrorCode } from "src/common/errors/error-codes";
import { PolicyDecision } from "src/policy/policy.types";

/**
 * Public contract for the deterministic transaction simulation preflight
 * (issue #109).
 *
 * The types here are intentionally transport-agnostic: the HTTP DTO is a thin
 * mapping over {@link PreflightOperation} + {@link PreflightStateSnapshot}, and
 * the evaluation core only ever sees these shapes. That is what makes the core
 * unit-testable without a Nest container, a clock or a network.
 */

/** High-risk operations the preflight knows how to guard. */
export type PreflightOperationKind =
  | "payment_transfer"
  | "trade"
  | "oracle_submission";

/**
 * Aggregate outcome. `blocking` means the operation MUST NOT be submitted;
 * `warning` means it may proceed but the caller should read the findings.
 */
export type PreflightStatus = "success" | "warning" | "blocking";

/** Finding severity. `info` never changes the aggregate status. */
export type PreflightSeverity = "info" | "warning" | "blocking";

/**
 * Stable, machine-readable finding codes. These are part of the contract —
 * clients branch on them, so renames are breaking changes.
 */
export type PreflightFindingCode =
  | "INVALID_OPERATION_AMOUNT"
  | "OPERATION_EXPIRED"
  | "STATE_VERSION_MISMATCH"
  | "STATE_SNAPSHOT_STALE"
  | "STATE_SNAPSHOT_AGING"
  | "BALANCE_STATE_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_ALLOWANCE"
  | "FEE_BUFFER_EXHAUSTED"
  | "DUPLICATE_OPERATION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENT_REPLAY"
  | "POLICY_STATE_UNAVAILABLE"
  | "TRADING_DISABLED"
  | "INVALID_TRADE_AMOUNT"
  | "TRADE_AMOUNT_LIMIT_EXCEEDED"
  | "TRADE_ASSET_NOT_ALLOWED"
  | "TRADE_SIDE_NOT_ALLOWED"
  | "ORACLE_PRICE_MISSING"
  | "ORACLE_PRICE_STALE"
  | "DESTINATION_NOT_VERIFIED";

/**
 * A single, self-contained preflight finding.
 *
 * Every finding carries a user-safe `message` and an actionable `remediation`;
 * neither ever contains internal state (balances are the caller's own inputs,
 * so they are safe to echo back, but no secrets are ever included).
 */
export interface PreflightFinding {
  code: PreflightFindingCode;
  severity: PreflightSeverity;
  /** Short, user-safe explanation of the problem. */
  message: string;
  /** Concrete next step the caller can take. */
  remediation: string;
  /** Operation field the finding applies to, when there is one. */
  field?: string;
  /** Existing error-taxonomy code this finding maps onto. */
  errorCode: ErrorCode;
  /** Deterministic, non-sensitive supporting values. */
  details?: Record<string, string | number | boolean | null>;
}

/** The operation being preflighted. */
export interface PreflightOperation {
  kind: PreflightOperationKind;
  asset: string;
  /** Exact decimal string, e.g. "10.5" (never a float). */
  amount: string;
  side?: string;
  destination?: string;
  idempotencyKey?: string;
  /**
   * Whether the operation depends on a fresh oracle price. Defaults to `true`
   * for `trade` and `oracle_submission`, `false` for `payment_transfer`.
   */
  requiresOraclePrice?: boolean;
  /** Snapshot version the operation was built against. */
  expectedStateVersion?: string;
  /** ISO timestamp after which the operation can no longer be submitted. */
  expiresAt?: string;
  /** Exact decimal string estimate of the network fee, when known. */
  estimatedFee?: string;
}

/** An oracle price observation included in the snapshot. */
export interface PreflightOraclePrice {
  asset: string;
  price: string;
  updatedAt: string;
}

/** An idempotency record included in the snapshot. */
export interface PreflightIdempotencyRecord {
  key: string;
  requestDigest: string;
  status?: string;
}

/**
 * The point-in-time state the operation is evaluated against. `observedAt`
 * must be supplied by the snapshot provider — it is what the stale-state rule
 * measures against `asOf`.
 */
export interface PreflightStateSnapshot {
  /** Opaque version the caller read the state at. */
  version: string;
  /** ISO timestamp the state was observed. */
  observedAt: string;
  /** Asset (upper-case) -> exact decimal balance string. */
  balances: Record<string, string>;
  /** Asset (upper-case) -> exact decimal allowance string. */
  allowances: Record<string, string>;
  /** Digests of operations already executed against this account. */
  consumedDigests: string[];
  idempotencyRecords: PreflightIdempotencyRecord[];
  /** Destinations verified for this account; empty means "not known". */
  verifiedDestinations: string[];
  oracle: PreflightOraclePrice[];
  /**
   * Result of the policy engine for `trade` operations. Supplied by the
   * snapshot provider from {@link PolicyDecision} so the preflight and the
   * policy engine cannot disagree.
   */
  policyDecision?: PolicyDecision;
}

/** Tunable freshness limits resolved from configuration. */
export interface PreflightThresholds {
  maxSnapshotAgeSeconds: number;
  warnSnapshotAgeSeconds: number;
  maxOracleAgeSeconds: number;
}

/** Everything the pure evaluator needs. Identical input => identical output. */
export interface PreflightEvaluationInput {
  operation: PreflightOperation;
  snapshot: PreflightStateSnapshot;
  thresholds: PreflightThresholds;
  /** ISO timestamp the evaluation runs at. Supplied by the caller. */
  asOf: string;
}

/** The preflight verdict returned to callers. */
export interface PreflightResult {
  /** Stable id derived from the input: `pf:<kind>:<hex>`. */
  preflightId: string;
  status: PreflightStatus;
  evaluationVersion: string;
  /** Digest of the normalised operation. */
  operationDigest: string;
  stateVersion: string;
  asOf: string;
  snapshotObservedAt: string;
  blockingCount: number;
  warningCount: number;
  /** Deterministically ordered findings (blocking first, then code). */
  findings: PreflightFinding[];
  /** Digest over the verdict itself; identical for identical results. */
  digest: string;
}
