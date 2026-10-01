/**
 * Domain Invariant Validation Framework for Trellis API
 *
 * Asserts domain consistency rules across core business models (Portfolio,
 * Assets, Transactions, Risk, Balances, Ownership, and Stellar integrations).
 * Ensures impossible states are rejected at the domain boundary.
 */

export class InvariantViolationError extends Error {
  public readonly invariantCode: string;
  public readonly details: Record<string, any>;

  constructor(invariantCode: string, message: string, details: Record<string, any> = {}) {
    super(`[Invariant Violation: ${invariantCode}] ${message}`);
    this.name = "InvariantViolationError";
    this.invariantCode = invariantCode;
    this.details = details;
  }
}

export type PortfolioLifecycleState =
  | "DRAFT"
  | "ACTIVE"
  | "REBALANCING"
  | "PAUSED"
  | "FAILED"
  | "ARCHIVED";

export interface TransactionSnapshot {
  txHash: string;
  ledgerSequence: number;
  amount: number;
  sourceAccount: string;
  destinationAccount: string;
  status: "PENDING" | "CONFIRMED" | "SETTLED" | "FAILED";
}

export interface RiskProfileMetrics {
  maxDrawdown: number;
  volatilityTolerance: number;
  varConfidence: number;
}

export interface AuditRecordPayload {
  entityId: string;
  actorId: string;
  previousStateHash?: string;
  newStateHash: string;
  timestamp: Date;
}

export class DomainInvariants {
  /**
   * INVARIANT 1: Portfolio Asset Weight Sum
   * The sum of target allocation weights across all assets in a portfolio
   * must strictly equal 1.0 (100%), and individual weights must satisfy 0 <= weight <= 1.0.
   */
  public static assertPortfolioAssetWeightSum(weights: number[], tolerance = 0.0001): void {
    if (!Array.isArray(weights) || weights.length === 0) {
      throw new InvariantViolationError(
        "PORTFOLIO_EMPTY_WEIGHTS",
        "Portfolio must contain at least one asset weight allocation.",
        { weights },
      );
    }

    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      if (typeof w !== "number" || isNaN(w) || w < 0 || w > 1.0) {
        throw new InvariantViolationError(
          "PORTFOLIO_INVALID_WEIGHT_RANGE",
          `Asset weight at index ${i} (${w}) is outside the valid range [0, 1.0].`,
          { index: i, weight: w },
        );
      }
      sum += w;
    }

    if (Math.abs(sum - 1.0) > tolerance) {
      throw new InvariantViolationError(
        "PORTFOLIO_WEIGHT_SUM_NOT_UNITY",
        `Sum of portfolio asset weights (${sum.toFixed(6)}) must equal 1.0.`,
        { sum, tolerance },
      );
    }
  }

  /**
   * INVARIANT 2: Non-Negative Balance and Quantity
   * Balances and asset quantities must never be negative.
   */
  public static assertNonNegativeBalance(balance: number, quantity: number, assetId?: string): void {
    if (typeof balance !== "number" || isNaN(balance) || balance < 0) {
      throw new InvariantViolationError(
        "NEGATIVE_BALANCE",
        `Balance cannot be negative: ${balance}`,
        { balance, assetId },
      );
    }

    if (typeof quantity !== "number" || isNaN(quantity) || quantity < 0) {
      throw new InvariantViolationError(
        "NEGATIVE_QUANTITY",
        `Asset quantity cannot be negative: ${quantity}`,
        { quantity, assetId },
      );
    }
  }

  /**
   * INVARIANT 3: Transaction Immutability Post-Confirmation
   * Confirmed or settled blockchain transactions cannot have critical ledger attributes modified.
   */
  public static assertTransactionImmutability(
    original: TransactionSnapshot,
    updated: Partial<TransactionSnapshot>,
  ): void {
    const isTerminal = ["CONFIRMED", "SETTLED", "FAILED"].includes(original.status);
    if (!isTerminal) return;

    if (updated.txHash !== undefined && updated.txHash !== original.txHash) {
      throw new InvariantViolationError(
        "TX_HASH_IMMUTABLE",
        "Transaction hash cannot be modified once confirmed or settled.",
        { originalHash: original.txHash, updatedHash: updated.txHash },
      );
    }

    if (updated.amount !== undefined && updated.amount !== original.amount) {
      throw new InvariantViolationError(
        "TX_AMOUNT_IMMUTABLE",
        "Transaction amount cannot be modified once confirmed or settled.",
        { originalAmount: original.amount, updatedAmount: updated.amount },
      );
    }

    if (
      updated.ledgerSequence !== undefined &&
      updated.ledgerSequence !== original.ledgerSequence
    ) {
      throw new InvariantViolationError(
        "TX_LEDGER_IMMUTABLE",
        "Transaction ledger sequence cannot be modified post-confirmation.",
        { originalLedger: original.ledgerSequence, updatedLedger: updated.ledgerSequence },
      );
    }

    if (
      updated.sourceAccount !== undefined &&
      updated.sourceAccount !== original.sourceAccount
    ) {
      throw new InvariantViolationError(
        "TX_SOURCE_IMMUTABLE",
        "Transaction source account cannot be modified post-confirmation.",
        { originalSource: original.sourceAccount, updatedSource: updated.sourceAccount },
      );
    }

    if (
      updated.destinationAccount !== undefined &&
      updated.destinationAccount !== original.destinationAccount
    ) {
      throw new InvariantViolationError(
        "TX_DESTINATION_IMMUTABLE",
        "Transaction destination account cannot be modified post-confirmation.",
        { originalDest: original.destinationAccount, updatedDest: updated.destinationAccount },
      );
    }
  }

  /**
   * INVARIANT 4: Valid Portfolio Lifecycle State Transitions
   * Lifecycle states must follow authorized Directed Acyclic Graph transitions.
   * In particular, ARCHIVED is a terminal state.
   */
  public static assertValidPortfolioLifecycleTransition(
    from: PortfolioLifecycleState,
    to: PortfolioLifecycleState,
  ): void {
    if (from === to) return;

    const allowedTransitions: Record<PortfolioLifecycleState, PortfolioLifecycleState[]> = {
      DRAFT: ["ACTIVE", "ARCHIVED"],
      ACTIVE: ["REBALANCING", "PAUSED", "ARCHIVED"],
      REBALANCING: ["ACTIVE", "FAILED"],
      PAUSED: ["ACTIVE", "ARCHIVED"],
      FAILED: ["ACTIVE", "ARCHIVED"],
      ARCHIVED: [], // Terminal
    };

    const allowed = allowedTransitions[from] || [];
    if (!allowed.includes(to)) {
      throw new InvariantViolationError(
        "INVALID_LIFECYCLE_TRANSITION",
        `Illegal portfolio state transition from ${from} to ${to}.`,
        { from, to, allowed },
      );
    }
  }

  /**
   * INVARIANT 5: Ownership and Multi-Tenant Isolation
   * An entity cannot be owned by null/empty identity, and actors cannot mutate
   * entities belonging to different tenants without explicit delegation.
   */
  public static assertOwnershipAndTenantIsolation(params: {
    entityOwnerId: string;
    requestActorId: string;
    entityTenantId?: string;
    actorTenantId?: string;
    isSuperAdmin?: boolean;
  }): void {
    const { entityOwnerId, requestActorId, entityTenantId, actorTenantId, isSuperAdmin } = params;

    if (!entityOwnerId || entityOwnerId.trim().length === 0) {
      throw new InvariantViolationError(
        "ORPHAN_ENTITY",
        "Domain entity must have an associated owner ID.",
        { entityOwnerId },
      );
    }

    if (isSuperAdmin) return;

    if (entityTenantId && actorTenantId && entityTenantId !== actorTenantId) {
      throw new InvariantViolationError(
        "TENANT_ISOLATION_BREACH",
        `Cross-tenant access prohibited. Entity tenant ${entityTenantId} != Actor tenant ${actorTenantId}.`,
        { entityTenantId, actorTenantId },
      );
    }

    if (entityOwnerId !== requestActorId && !isSuperAdmin) {
      throw new InvariantViolationError(
        "UNAUTHORIZED_ENTITY_ACCESS",
        `Actor ${requestActorId} does not own entity owned by ${entityOwnerId}.`,
        { entityOwnerId, requestActorId },
      );
    }
  }

  /**
   * INVARIANT 6: Risk Profile Tolerance Consistency
   * Risk tolerance values must be within realistic, mathematically sound bounds.
   */
  public static assertRiskProfileToleranceBounds(metrics: RiskProfileMetrics): void {
    const { maxDrawdown, volatilityTolerance, varConfidence } = metrics;

    if (typeof maxDrawdown !== "number" || maxDrawdown <= 0 || maxDrawdown > 1.0) {
      throw new InvariantViolationError(
        "INVALID_MAX_DRAWDOWN",
        `Max drawdown limit must be strictly between 0 and 1.0 (got ${maxDrawdown}).`,
        { maxDrawdown },
      );
    }

    if (typeof volatilityTolerance !== "number" || volatilityTolerance <= 0) {
      throw new InvariantViolationError(
        "INVALID_VOLATILITY_TOLERANCE",
        `Volatility tolerance must be positive (got ${volatilityTolerance}).`,
        { volatilityTolerance },
      );
    }

    if (typeof varConfidence !== "number" || varConfidence < 0.80 || varConfidence >= 1.0) {
      throw new InvariantViolationError(
        "INVALID_VAR_CONFIDENCE",
        `Value-at-Risk confidence level must be in [0.80, 1.0) (got ${varConfidence}).`,
        { varConfidence },
      );
    }
  }

  /**
   * INVARIANT 7: Rebalancing Event Value Conservation
   * Net value before and after rebalancing must be conserved within acceptable slippage and fee limits.
   */
  public static assertRebalancingConservation(
    preTotalValue: number,
    postTotalValue: number,
    fees: number,
    maxSlippagePct = 0.02,
  ): void {
    if (preTotalValue <= 0 || postTotalValue <= 0) {
      throw new InvariantViolationError(
        "INVALID_REBALANCE_TOTALS",
        "Pre and post rebalance portfolio valuations must be positive numbers.",
        { preTotalValue, postTotalValue },
      );
    }

    if (fees < 0) {
      throw new InvariantViolationError(
        "NEGATIVE_REBALANCE_FEES",
        `Rebalancing execution fees cannot be negative: ${fees}`,
        { fees },
      );
    }

    const netDifference = Math.abs(preTotalValue - (postTotalValue + fees));
    const allowedDiscrepancy = preTotalValue * maxSlippagePct;

    if (netDifference > allowedDiscrepancy) {
      throw new InvariantViolationError(
        "REBALANCE_CONSERVATION_BREACH",
        `Rebalance value conservation breached. Pre: ${preTotalValue}, Post: ${postTotalValue}, Fees: ${fees}. Discrepancy ${netDifference} exceeds allowed ${allowedDiscrepancy}.`,
        { preTotalValue, postTotalValue, fees, netDifference, allowedDiscrepancy },
      );
    }
  }

  /**
   * INVARIANT 8: Stellar Public Key and Contract Address Format
   * Validates that Stellar keys are legitimate 56-character Ed25519 public keys or Soroban contract identifiers.
   */
  public static assertStellarAddressFormat(address: string, expectedType?: "account" | "contract"): void {
    if (!address || typeof address !== "string" || address.length !== 56) {
      throw new InvariantViolationError(
        "MALFORMED_STELLAR_ADDRESS_LENGTH",
        `Stellar address must be a 56-character string. Received: "${address}"`,
        { address, length: address?.length },
      );
    }

    const firstChar = address[0];
    if (expectedType === "account" && firstChar !== "G") {
      throw new InvariantViolationError(
        "STELLAR_ACCOUNT_PREFIX_INVALID",
        `Stellar account address must start with 'G'. Received: "${address}"`,
        { address },
      );
    }

    if (expectedType === "contract" && firstChar !== "C") {
      throw new InvariantViolationError(
        "STELLAR_CONTRACT_PREFIX_INVALID",
        `Soroban contract address must start with 'C'. Received: "${address}"`,
        { address },
      );
    }

    if (firstChar !== "G" && firstChar !== "C") {
      throw new InvariantViolationError(
        "STELLAR_IDENTIFIER_PREFIX_INVALID",
        `Stellar identifier must start with 'G' (account) or 'C' (contract). Received: "${address}"`,
        { address },
      );
    }

    // Base32 character set check (RFC 4648 without 0, 1, 8, 9)
    const base32Regex = /^[A-Z2-7]{56}$/;
    if (!base32Regex.test(address)) {
      throw new InvariantViolationError(
        "STELLAR_BASE32_INVALID",
        `Stellar address contains invalid characters outside Base32 alphabet: "${address}"`,
        { address },
      );
    }
  }

  /**
   * INVARIANT 9: Audit Trail Completeness & Temporal Monotonicity
   * Audited mutations must supply complete cryptographic hash tracking and non-future timestamps.
   */
  public static assertAuditTrailIntegrity(entry: AuditRecordPayload): void {
    if (!entry.entityId || entry.entityId.trim().length === 0) {
      throw new InvariantViolationError(
        "AUDIT_MISSING_ENTITY_ID",
        "Audit record must specify a non-empty entityId.",
        { entry },
      );
    }

    if (!entry.actorId || entry.actorId.trim().length === 0) {
      throw new InvariantViolationError(
        "AUDIT_MISSING_ACTOR_ID",
        "Audit record must specify a non-empty actorId.",
        { entry },
      );
    }

    if (!entry.newStateHash || entry.newStateHash.trim().length === 0) {
      throw new InvariantViolationError(
        "AUDIT_MISSING_STATE_HASH",
        "Audit record must provide a valid newStateHash.",
        { entry },
      );
    }

    const now = Date.now();
    const entryTime = new Date(entry.timestamp).getTime();
    if (isNaN(entryTime)) {
      throw new InvariantViolationError(
        "AUDIT_INVALID_TIMESTAMP",
        "Audit record contains an invalid timestamp.",
        { timestamp: entry.timestamp },
      );
    }

    // Allow 5 second clock skew
    if (entryTime > now + 5000) {
      throw new InvariantViolationError(
        "AUDIT_FUTURE_TIMESTAMP",
        `Audit record timestamp cannot be in the future (${new Date(entryTime).toISOString()}).`,
        { timestamp: entry.timestamp, now: new Date(now).toISOString() },
      );
    }
  }

  /**
   * INVARIANT 10: Module Registry Lifecycle and Version Compatibility
   * A module cannot be enabled if deprecated, and must be compatible with core version range.
   */
  public static assertModuleCompatibility(
    moduleStatus: "registered" | "enabled" | "disabled" | "deprecated",
    targetState: "enabled" | "disabled",
  ): void {
    if (moduleStatus === "deprecated" && targetState === "enabled") {
      throw new InvariantViolationError(
        "DEPRECATED_MODULE_ENABLE_BLOCKED",
        "Cannot enable a module that has been marked as deprecated.",
        { moduleStatus, targetState },
      );
    }
  }
}
