import { ErrorCode } from "src/common/errors/error-codes";
import {
  PolicyDecision,
  PolicyViolation,
  PolicyViolationCode,
} from "src/policy/policy.types";
import {
  DEFAULT_MAX_ORACLE_AGE_SECONDS,
  DEFAULT_MAX_SNAPSHOT_AGE_SECONDS,
  DEFAULT_WARN_SNAPSHOT_AGE_SECONDS,
  PREFLIGHT_EVALUATION_VERSION,
} from "./preflight.constants";
import { compareDecimal, subtractDecimal, normalizeDecimal, isDecimalString } from "./preflight.decimal";
import {
  PREFLIGHT_DIGEST_NAMESPACE,
  canonicalize,
  digestValue,
  preflightDigest,
  preflightId,
} from "./preflight.determinism";
import {
  PreflightEvaluationInput,
  PreflightFinding,
  PreflightFindingCode,
  PreflightIdempotencyRecord,
  PreflightOperation,
  PreflightOraclePrice,
  PreflightResult,
  PreflightSeverity,
  PreflightStateSnapshot,
  PreflightStatus,
  PreflightThresholds,
} from "./preflight.types";

/**
 * The pure evaluation core (issue #109).
 *
 * `evaluatePreflight` is a total function of its input: no clock, no I/O, no
 * randomness. Every rule is evaluated independently, findings are sorted into a
 * canonical order, and the result (including its digest) is derived only from
 * the input. That is what makes the preflight reproducible in tests and safe to
 * run before submitting a high-risk operation.
 */

/** Severity ordering used for the canonical finding order. */
const SEVERITY_RANK: Record<PreflightSeverity, number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

/** Locale-independent string comparison so ordering never varies by host. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Parse an ISO timestamp to epoch ms, or `NaN`. */
function parseTime(value: string | undefined): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

/** Age in seconds, or `Infinity` when either timestamp is unusable. */
function ageSeconds(asOf: string, observedAt: string): number {
  const now = parseTime(asOf);
  const then = parseTime(observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - then) / 1000);
}

/** Normalise an operation so equal operations hash and compare identically. */
export function normalizeOperation(
  operation: PreflightOperation,
): PreflightOperation {
  return {
    kind: operation.kind,
    asset: String(operation.asset ?? "").trim().toUpperCase(),
    amount: safeNormalize(operation.amount),
    side: operation.side,
    destination: operation.destination,
    idempotencyKey: operation.idempotencyKey,
    requiresOraclePrice: operation.requiresOraclePrice,
    expectedStateVersion: operation.expectedStateVersion,
    expiresAt: operation.expiresAt,
    estimatedFee:
      operation.estimatedFee === undefined
        ? undefined
        : safeNormalize(operation.estimatedFee),
  };
}

/** Canonical decimal form, or the original value when it is not a decimal. */
function safeNormalize(value: string): string {
  return isDecimalString(value) ? normalizeDecimal(value) : String(value ?? "");
}

function normalizeAssetMap(
  values: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(values ?? {})) {
    // Values that are not decimal strings are dropped so the affected asset is
    // reported as "state unavailable" rather than silently compared as NaN.
    if (isDecimalString(values[key])) {
      normalized[key.trim().toUpperCase()] = normalizeDecimal(values[key]);
    }
  }
  return normalized;
}

/**
 * Put set-like snapshot collections into a canonical order so two snapshots
 * that differ only by array order produce identical results and digests.
 */
export function normalizeSnapshot(
  snapshot: PreflightStateSnapshot,
): PreflightStateSnapshot {
  const idempotencyRecords: PreflightIdempotencyRecord[] = [
    ...(snapshot.idempotencyRecords ?? []),
  ].sort((a, b) => compareStrings(a.key, b.key));
  const oracle: PreflightOraclePrice[] = [...(snapshot.oracle ?? [])]
    .map((entry) => ({
      asset: String(entry.asset ?? "").trim().toUpperCase(),
      price: entry.price,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => compareStrings(a.asset, b.asset));

  return {
    version: snapshot.version,
    observedAt: snapshot.observedAt,
    balances: normalizeAssetMap(snapshot.balances ?? {}),
    allowances: normalizeAssetMap(snapshot.allowances ?? {}),
    consumedDigests: [...new Set(snapshot.consumedDigests ?? [])].sort(
      compareStrings,
    ),
    idempotencyRecords,
    verifiedDestinations: [...new Set(snapshot.verifiedDestinations ?? [])].sort(
      compareStrings,
    ),
    oracle,
    policyDecision: snapshot.policyDecision,
  };
}

/** Digest of the normalised operation; also the idempotency fingerprint. */
export function buildOperationDigest(operation: PreflightOperation): string {
  return preflightDigest(
    PREFLIGHT_DIGEST_NAMESPACE,
    "operation",
    canonicalize(normalizeOperation(operation)),
  );
}

function finding(
  code: PreflightFindingCode,
  severity: PreflightSeverity,
  errorCode: ErrorCode,
  message: string,
  remediation: string,
  field?: string,
  details?: Record<string, string | number | boolean | null>,
): PreflightFinding {
  return { code, severity, errorCode, message, remediation, field, details };
}

/** Map a policy-engine violation onto a preflight finding. */
function policyViolationFinding(violation: PolicyViolation): PreflightFinding {
  const codeMap: Record<
    PolicyViolationCode,
    { code: PreflightFindingCode; errorCode: ErrorCode; remediation: string }
  > = {
    TRADING_DISABLED: {
      code: "TRADING_DISABLED",
      errorCode: ErrorCode.PRECONDITION_FAILED,
      remediation: "Retry the operation once trading is re-enabled.",
    },
    INVALID_TRADE_AMOUNT: {
      code: "INVALID_TRADE_AMOUNT",
      errorCode: ErrorCode.VALIDATION_ERROR,
      remediation: "Provide an amount greater than zero and retry.",
    },
    TRADE_AMOUNT_LIMIT_EXCEEDED: {
      code: "TRADE_AMOUNT_LIMIT_EXCEEDED",
      errorCode: ErrorCode.RISK_LIMIT_EXCEEDED,
      remediation:
        violation.limit === undefined
          ? "Lower the amount to within the configured limit."
          : `Lower the amount to ${violation.limit} or below.`,
    },
    ASSET_NOT_ALLOWED: {
      code: "TRADE_ASSET_NOT_ALLOWED",
      errorCode: ErrorCode.ASSET_UNSUPPORTED,
      remediation: "Choose an asset that is enabled for trading.",
    },
    TRADE_SIDE_NOT_ALLOWED: {
      code: "TRADE_SIDE_NOT_ALLOWED",
      errorCode: ErrorCode.PRECONDITION_FAILED,
      remediation: "Use a trade side enabled by the current policy.",
    },
  };

  const mapped = codeMap[violation.code];
  const details: Record<string, string | number | boolean | null> = {};
  if (violation.limit !== undefined) details.limit = violation.limit;
  if (violation.allowedValues !== undefined) {
    details.allowedValues = violation.allowedValues.join(",");
  }

  return finding(
    mapped.code,
    "blocking",
    mapped.errorCode,
    violation.message,
    mapped.remediation,
    violation.field,
    Object.keys(details).length > 0 ? details : undefined,
  );
}

function requiresOraclePrice(operation: PreflightOperation): boolean {
  if (operation.requiresOraclePrice !== undefined) {
    return operation.requiresOraclePrice;
  }
  return operation.kind !== "payment_transfer";
}

function checkExpiry(
  operation: PreflightOperation,
  asOf: string,
  findings: PreflightFinding[],
): void {
  if (!operation.expiresAt) return;
  const expiresAt = parseTime(operation.expiresAt);
  const now = parseTime(asOf);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return;
  if (expiresAt > now) return;

  findings.push(
    finding(
      "OPERATION_EXPIRED",
      "blocking",
      ErrorCode.PRECONDITION_FAILED,
      `This operation expired at ${operation.expiresAt} and can no longer be submitted.`,
      "Build and sign a new operation with a future expiry, then preflight it again.",
      "expiresAt",
      { expiresAt: operation.expiresAt, asOf },
    ),
  );
}

function checkStateVersion(
  operation: PreflightOperation,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  if (!operation.expectedStateVersion) return;
  if (operation.expectedStateVersion === snapshot.version) return;

  findings.push(
    finding(
      "STATE_VERSION_MISMATCH",
      "blocking",
      ErrorCode.CONFLICT,
      `The account state changed since this operation was prepared: expected version ${operation.expectedStateVersion}, current version ${snapshot.version}.`,
      `Re-read the current state at version ${snapshot.version} and rebuild the operation before submitting.`,
      "expectedStateVersion",
      {
        expectedStateVersion: operation.expectedStateVersion,
        currentStateVersion: snapshot.version,
      },
    ),
  );
}

function checkSnapshotFreshness(
  snapshot: PreflightStateSnapshot,
  thresholds: PreflightThresholds,
  asOf: string,
  findings: PreflightFinding[],
): void {
  const age = ageSeconds(asOf, snapshot.observedAt);

  if (age > thresholds.maxSnapshotAgeSeconds) {
    findings.push(
      finding(
        "STATE_SNAPSHOT_STALE",
        "blocking",
        ErrorCode.PRECONDITION_FAILED,
        `The state snapshot is ${Math.round(age)}s old, which is beyond the ${thresholds.maxSnapshotAgeSeconds}s freshness limit.`,
        "Refresh the state snapshot and rebuild the operation before submitting.",
        "observedAt",
        {
          snapshotAgeSeconds: Math.round(age),
          maxSnapshotAgeSeconds: thresholds.maxSnapshotAgeSeconds,
          observedAt: snapshot.observedAt,
        },
      ),
    );
    return;
  }

  if (age > thresholds.warnSnapshotAgeSeconds) {
    findings.push(
      finding(
        "STATE_SNAPSHOT_AGING",
        "warning",
        ErrorCode.PRECONDITION_FAILED,
        `The state snapshot is ${Math.round(age)}s old and is approaching the ${thresholds.maxSnapshotAgeSeconds}s freshness limit.`,
        "Refresh the snapshot before submitting if the operation is time-sensitive.",
        "observedAt",
        {
          snapshotAgeSeconds: Math.round(age),
          warnSnapshotAgeSeconds: thresholds.warnSnapshotAgeSeconds,
          maxSnapshotAgeSeconds: thresholds.maxSnapshotAgeSeconds,
        },
      ),
    );
  }
}

function checkDuplicate(
  operationDigest: string,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  if (!snapshot.consumedDigests.includes(operationDigest)) return;

  findings.push(
    finding(
      "DUPLICATE_OPERATION",
      "blocking",
      ErrorCode.DUPLICATE_PAYMENT_SUBMISSION,
      "An identical operation has already been executed against this account.",
      "Do not resubmit. Look up the existing transaction status instead.",
      undefined,
      { operationDigest },
    ),
  );
}

function checkIdempotency(
  operation: PreflightOperation,
  operationDigest: string,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  if (!operation.idempotencyKey) return;
  const record = snapshot.idempotencyRecords.find(
    (entry) => entry.key === operation.idempotencyKey,
  );
  if (!record) return;

  if (record.requestDigest !== operationDigest) {
    findings.push(
      finding(
        "IDEMPOTENCY_KEY_REUSED",
        "blocking",
        ErrorCode.CONFLICT,
        `Idempotency key ${operation.idempotencyKey} was already used for a different request.`,
        "Use a new idempotency key for a different payload.",
        "idempotencyKey",
        { idempotencyKey: operation.idempotencyKey },
      ),
    );
    return;
  }

  if ((record.status ?? "").toLowerCase() === "in_progress") {
    findings.push(
      finding(
        "IDEMPOTENCY_IN_PROGRESS",
        "blocking",
        ErrorCode.CONFLICT,
        `A request with idempotency key ${operation.idempotencyKey} is already in progress.`,
        "Wait for the in-flight request to finish, then retry with the same key.",
        "idempotencyKey",
        { idempotencyKey: operation.idempotencyKey },
      ),
    );
    return;
  }

  if ((record.status ?? "").toLowerCase() === "completed") {
    findings.push(
      finding(
        "IDEMPOTENT_REPLAY",
        "info",
        ErrorCode.DUPLICATE_PAYMENT_SUBMISSION,
        "This request was already completed and will be replayed from storage.",
        "No action needed — the stored response is returned instead of re-executing.",
        "idempotencyKey",
        { idempotencyKey: operation.idempotencyKey },
      ),
    );
  }
}

function checkBalanceAndFee(
  operation: PreflightOperation,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  if (operation.kind === "oracle_submission") return;
  const asset = operation.asset;
  const balance = snapshot.balances[asset];

  if (balance === undefined) {
    findings.push(
      finding(
        "BALANCE_STATE_UNAVAILABLE",
        "blocking",
        ErrorCode.PRECONDITION_FAILED,
        `No current balance is available for ${asset}, so the transfer cannot be validated.`,
        "Refresh the account balance for the requested asset and retry.",
        "asset",
        { asset },
      ),
    );
    return;
  }

  if (compareDecimal(operation.amount, balance) > 0) {
    findings.push(
      finding(
        "INSUFFICIENT_BALANCE",
        "blocking",
        ErrorCode.INSUFFICIENT_FUNDS,
        `Requested amount ${operation.amount} ${asset} exceeds the available balance of ${balance} ${asset}.`,
        `Fund the account or lower the amount to ${balance} ${asset} or below.`,
        "amount",
        {
          asset,
          amount: operation.amount,
          available: balance,
          shortfall: subtractDecimal(operation.amount, balance),
        },
      ),
    );
    return;
  }

  const fee = operation.estimatedFee;
  if (fee !== undefined && compareDecimal(fee, "0") > 0) {
    const remaining = subtractDecimal(balance, operation.amount);
    if (compareDecimal(remaining, fee) < 0) {
      findings.push(
        finding(
          "FEE_BUFFER_EXHAUSTED",
          "warning",
          ErrorCode.INSUFFICIENT_FUNDS,
          `The amount leaves ${remaining} ${asset}, which is below the estimated network fee of ${fee} ${asset}.`,
          `Lower the amount by at least ${subtractDecimal(fee, remaining)} ${asset} to keep the fee covered.`,
          "amount",
          {
            asset,
            remaining,
            estimatedFee: fee,
            shortfall: subtractDecimal(fee, remaining),
          },
        ),
      );
    }
  }
}

function checkAllowance(
  operation: PreflightOperation,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  const asset = operation.asset;
  if (!Object.prototype.hasOwnProperty.call(snapshot.allowances, asset)) return;
  const allowance = snapshot.allowances[asset];
  if (compareDecimal(operation.amount, allowance) <= 0) return;

  findings.push(
    finding(
      "INSUFFICIENT_ALLOWANCE",
      "blocking",
      ErrorCode.INSUFFICIENT_FUNDS,
      `Requested amount ${operation.amount} ${asset} exceeds the approved allowance of ${allowance} ${asset}.`,
      "Increase the token allowance or lower the amount before submitting.",
      "amount",
      { asset, amount: operation.amount, allowance },
    ),
  );
}

function isPolicyDenied(
  decision: PolicyDecision,
): decision is { allowed: false; violation: PolicyViolation } {
  return decision.allowed === false;
}

function checkTradePolicy(
  operation: PreflightOperation,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  if (operation.kind !== "trade") return;

  const decision = snapshot.policyDecision;
  if (!decision) {
    findings.push(
      finding(
        "POLICY_STATE_UNAVAILABLE",
        "blocking",
        ErrorCode.PRECONDITION_FAILED,
        "The trading policy could not be evaluated for this operation.",
        "Retry once the policy engine is reachable, or submit through the standard trade endpoint.",
        "kind",
      ),
    );
    return;
  }

  if (isPolicyDenied(decision)) {
    findings.push(policyViolationFinding(decision.violation));
  }
}

function checkOracle(
  operation: PreflightOperation,
  snapshot: PreflightStateSnapshot,
  thresholds: PreflightThresholds,
  asOf: string,
  findings: PreflightFinding[],
): void {
  if (!requiresOraclePrice(operation)) return;

  const entry = snapshot.oracle.find(
    (oracle) => oracle.asset === operation.asset,
  );
  if (!entry) {
    findings.push(
      finding(
        "ORACLE_PRICE_MISSING",
        "blocking",
        ErrorCode.ORACLE_VERIFICATION_FAILED,
        `No oracle price is available for ${operation.asset}.`,
        "Wait for a price-feed update, or route the operation through a manual price source.",
        "asset",
        { asset: operation.asset },
      ),
    );
    return;
  }

  const age = ageSeconds(asOf, entry.updatedAt);
  if (age > thresholds.maxOracleAgeSeconds) {
    findings.push(
      finding(
        "ORACLE_PRICE_STALE",
        "blocking",
        ErrorCode.ORACLE_VERIFICATION_FAILED,
        `The oracle price for ${operation.asset} is ${Math.round(age)}s old, beyond the ${thresholds.maxOracleAgeSeconds}s freshness limit.`,
        "Wait for a fresh oracle price before submitting this operation.",
        "asset",
        {
          asset: operation.asset,
          oracleAgeSeconds: Math.round(age),
          maxOracleAgeSeconds: thresholds.maxOracleAgeSeconds,
          updatedAt: entry.updatedAt,
        },
      ),
    );
  }
}

function checkDestination(
  operation: PreflightOperation,
  snapshot: PreflightStateSnapshot,
  findings: PreflightFinding[],
): void {
  if (operation.kind !== "payment_transfer") return;
  if (!operation.destination) return;
  if (snapshot.verifiedDestinations.length === 0) return;
  if (snapshot.verifiedDestinations.includes(operation.destination)) return;

  findings.push(
    finding(
      "DESTINATION_NOT_VERIFIED",
      "warning",
      ErrorCode.PRECONDITION_FAILED,
      `Destination ${operation.destination} has not been verified for this account.`,
      "Confirm the destination address before submitting — on-chain transfers are irreversible.",
      "destination",
      { destination: operation.destination },
    ),
  );
}

/** Sort findings into the canonical order used for output and hashing. */
export function sortFindings(findings: PreflightFinding[]): PreflightFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.field ?? "", b.field ?? "") ||
      compareStrings(a.message, b.message),
  );
}

/** ISO string when parseable, otherwise the raw value (age becomes infinite). */
function toIsoOrRaw(value: string): string {
  const parsed = parseTime(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value ?? "");
}

/**
 * Evaluate an operation against a snapshot. Pure and total: the same input
 * always yields the same {@link PreflightResult}.
 */
export function evaluatePreflight(
  input: PreflightEvaluationInput,
): PreflightResult {
  const operation = normalizeOperation(input.operation);
  const snapshot = normalizeSnapshot(input.snapshot);
  const thresholds = input.thresholds;
  const asOf = toIsoOrRaw(input.asOf);

  const findings: PreflightFinding[] = [];

  if (!isDecimalString(operation.amount)) {
    findings.push(
      finding(
        "INVALID_OPERATION_AMOUNT",
        "blocking",
        ErrorCode.VALIDATION_ERROR,
        "The operation amount is not a valid non-negative decimal string.",
        "Provide the amount as a decimal string such as '10' or '10.5'.",
        "amount",
      ),
    );
  } else {
    checkExpiry(operation, asOf, findings);
    checkStateVersion(operation, snapshot, findings);
    checkSnapshotFreshness(snapshot, thresholds, asOf, findings);
    const operationDigest = buildOperationDigest(operation);
    checkDuplicate(operationDigest, snapshot, findings);
    checkIdempotency(operation, operationDigest, snapshot, findings);
    checkBalanceAndFee(operation, snapshot, findings);
    checkAllowance(operation, snapshot, findings);
    checkTradePolicy(operation, snapshot, findings);
    checkOracle(operation, snapshot, thresholds, asOf, findings);
    checkDestination(operation, snapshot, findings);
  }

  const operationDigest = buildOperationDigest(operation);
  const ordered = sortFindings(findings);
  const blockingCount = ordered.filter((f) => f.severity === "blocking").length;
  const warningCount = ordered.filter((f) => f.severity === "warning").length;
  const status: PreflightStatus =
    blockingCount > 0 ? "blocking" : warningCount > 0 ? "warning" : "success";

  const observedAt = toIsoOrRaw(snapshot.observedAt);
  const idDigest = preflightDigest(
    PREFLIGHT_DIGEST_NAMESPACE,
    "id",
    operationDigest,
    snapshot.version,
    asOf,
    observedAt,
    PREFLIGHT_EVALUATION_VERSION,
  );
  const resultId = preflightId(operation.kind, idDigest);

  const digest = digestValue({
    preflightId: resultId,
    status,
    evaluationVersion: PREFLIGHT_EVALUATION_VERSION,
    findings: ordered,
  });

  return {
    preflightId: resultId,
    status,
    evaluationVersion: PREFLIGHT_EVALUATION_VERSION,
    operationDigest,
    stateVersion: snapshot.version,
    asOf,
    snapshotObservedAt: observedAt,
    blockingCount,
    warningCount,
    findings: ordered,
    digest,
  };
}

/** Default thresholds used when callers do not override them. */
export function defaultPreflightThresholds(): PreflightThresholds {
  return {
    maxSnapshotAgeSeconds: DEFAULT_MAX_SNAPSHOT_AGE_SECONDS,
    warnSnapshotAgeSeconds: DEFAULT_WARN_SNAPSHOT_AGE_SECONDS,
    maxOracleAgeSeconds: DEFAULT_MAX_ORACLE_AGE_SECONDS,
  };
}
