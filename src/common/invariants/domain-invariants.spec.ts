import {
  DomainInvariants,
  InvariantViolationError,
  PortfolioLifecycleState,
  TransactionSnapshot,
} from "./domain-invariants";

describe("Domain Invariant Test Suite (Issue #50)", () => {
  describe("Invariant 1: Portfolio Asset Weight Sum", () => {
    it("accepts valid allocation weights summing to 1.0", () => {
      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([0.5, 0.3, 0.2]),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([0.25, 0.25, 0.25, 0.25]),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([1.0]),
      ).not.toThrow();
    });

    it("rejects allocation weights not summing to 1.0", () => {
      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([0.5, 0.4]),
      ).toThrow(InvariantViolationError);

      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([0.7, 0.5]),
      ).toThrow("PORTFOLIO_WEIGHT_SUM_NOT_UNITY");
    });

    it("rejects negative or out-of-bound weights", () => {
      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([-0.1, 1.1]),
      ).toThrow("PORTFOLIO_INVALID_WEIGHT_RANGE");

      expect(() =>
        DomainInvariants.assertPortfolioAssetWeightSum([]),
      ).toThrow("PORTFOLIO_EMPTY_WEIGHTS");
    });
  });

  describe("Invariant 2: Non-Negative Balance and Quantity", () => {
    it("accepts non-negative balances and quantities", () => {
      expect(() =>
        DomainInvariants.assertNonNegativeBalance(100.5, 50, "USDC"),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertNonNegativeBalance(0, 0, "XLM"),
      ).not.toThrow();
    });

    it("rejects impossible negative balance or quantity states", () => {
      expect(() =>
        DomainInvariants.assertNonNegativeBalance(-0.01, 10, "USDC"),
      ).toThrow("NEGATIVE_BALANCE");

      expect(() =>
        DomainInvariants.assertNonNegativeBalance(100, -5, "XLM"),
      ).toThrow("NEGATIVE_QUANTITY");
    });
  });

  describe("Invariant 3: Transaction Immutability Post-Confirmation", () => {
    const original: TransactionSnapshot = {
      txHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      ledgerSequence: 1234567,
      amount: 150.0,
      sourceAccount: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      destinationAccount: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
      status: "CONFIRMED",
    };

    it("allows non-critical or matching updates", () => {
      expect(() =>
        DomainInvariants.assertTransactionImmutability(original, {
          ledgerSequence: 1234567,
          amount: 150.0,
        }),
      ).not.toThrow();
    });

    it("rejects mutation of amount on confirmed transaction", () => {
      expect(() =>
        DomainInvariants.assertTransactionImmutability(original, {
          amount: 200.0,
        }),
      ).toThrow("TX_AMOUNT_IMMUTABLE");
    });

    it("rejects mutation of txHash on confirmed transaction", () => {
      expect(() =>
        DomainInvariants.assertTransactionImmutability(original, {
          txHash: "altered_hash",
        }),
      ).toThrow("TX_HASH_IMMUTABLE");
    });

    it("rejects mutation of accounts or ledger sequence", () => {
      expect(() =>
        DomainInvariants.assertTransactionImmutability(original, {
          sourceAccount: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF3",
        }),
      ).toThrow("TX_SOURCE_IMMUTABLE");

      expect(() =>
        DomainInvariants.assertTransactionImmutability(original, {
          ledgerSequence: 9999999,
        }),
      ).toThrow("TX_LEDGER_IMMUTABLE");
    });
  });

  describe("Invariant 4: Portfolio Lifecycle State Transitions", () => {
    it("allows valid transitions through the lifecycle DAG", () => {
      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("DRAFT", "ACTIVE"),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("ACTIVE", "REBALANCING"),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("REBALANCING", "ACTIVE"),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("ACTIVE", "ARCHIVED"),
      ).not.toThrow();
    });

    it("rejects illegal transitions out of terminal ARCHIVED state", () => {
      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("ARCHIVED", "ACTIVE"),
      ).toThrow("INVALID_LIFECYCLE_TRANSITION");

      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("ARCHIVED", "REBALANCING"),
      ).toThrow("INVALID_LIFECYCLE_TRANSITION");
    });

    it("rejects skipping lifecycle phases (e.g. DRAFT -> REBALANCING)", () => {
      expect(() =>
        DomainInvariants.assertValidPortfolioLifecycleTransition("DRAFT", "REBALANCING"),
      ).toThrow("INVALID_LIFECYCLE_TRANSITION");
    });
  });

  describe("Invariant 5: Ownership and Multi-Tenant Isolation", () => {
    it("allows authorized access within same tenant", () => {
      expect(() =>
        DomainInvariants.assertOwnershipAndTenantIsolation({
          entityOwnerId: "user-1",
          requestActorId: "user-1",
          entityTenantId: "tenant-a",
          actorTenantId: "tenant-a",
        }),
      ).not.toThrow();
    });

    it("rejects orphan entity with missing owner", () => {
      expect(() =>
        DomainInvariants.assertOwnershipAndTenantIsolation({
          entityOwnerId: "",
          requestActorId: "user-1",
        }),
      ).toThrow("ORPHAN_ENTITY");
    });

    it("rejects cross-tenant access breach", () => {
      expect(() =>
        DomainInvariants.assertOwnershipAndTenantIsolation({
          entityOwnerId: "user-1",
          requestActorId: "user-1",
          entityTenantId: "tenant-alpha",
          actorTenantId: "tenant-beta",
        }),
      ).toThrow("TENANT_ISOLATION_BREACH");
    });

    it("rejects unauthorized non-owner access", () => {
      expect(() =>
        DomainInvariants.assertOwnershipAndTenantIsolation({
          entityOwnerId: "user-owner",
          requestActorId: "user-stranger",
          entityTenantId: "tenant-a",
          actorTenantId: "tenant-a",
        }),
      ).toThrow("UNAUTHORIZED_ENTITY_ACCESS");
    });

    it("allows superadmin override", () => {
      expect(() =>
        DomainInvariants.assertOwnershipAndTenantIsolation({
          entityOwnerId: "user-owner",
          requestActorId: "superadmin",
          entityTenantId: "tenant-alpha",
          actorTenantId: "tenant-beta",
          isSuperAdmin: true,
        }),
      ).not.toThrow();
    });
  });

  describe("Invariant 6: Risk Profile Tolerance Consistency", () => {
    it("accepts valid risk profile tolerance metrics", () => {
      expect(() =>
        DomainInvariants.assertRiskProfileToleranceBounds({
          maxDrawdown: 0.2,
          volatilityTolerance: 0.15,
          varConfidence: 0.95,
        }),
      ).not.toThrow();
    });

    it("rejects impossible drawdown limits (<= 0 or > 1.0)", () => {
      expect(() =>
        DomainInvariants.assertRiskProfileToleranceBounds({
          maxDrawdown: 1.5,
          volatilityTolerance: 0.15,
          varConfidence: 0.95,
        }),
      ).toThrow("INVALID_MAX_DRAWDOWN");

      expect(() =>
        DomainInvariants.assertRiskProfileToleranceBounds({
          maxDrawdown: -0.1,
          volatilityTolerance: 0.15,
          varConfidence: 0.95,
        }),
      ).toThrow("INVALID_MAX_DRAWDOWN");
    });

    it("rejects out-of-range Value-at-Risk confidence", () => {
      expect(() =>
        DomainInvariants.assertRiskProfileToleranceBounds({
          maxDrawdown: 0.25,
          volatilityTolerance: 0.1,
          varConfidence: 0.5,
        }),
      ).toThrow("INVALID_VAR_CONFIDENCE");
    });
  });

  describe("Invariant 7: Rebalancing Event Value Conservation", () => {
    it("accepts rebalancing preserving net asset value within slippage tolerance", () => {
      // Pre: 10,000, Post: 9,920, Fees: 50 -> net diff = 30 (0.3% <= 2% allowed)
      expect(() =>
        DomainInvariants.assertRebalancingConservation(10000, 9920, 50, 0.02),
      ).not.toThrow();
    });

    it("rejects severe leakage or unexplained loss exceeding slippage tolerance", () => {
      // Pre: 10,000, Post: 9,000, Fees: 50 -> net diff = 950 (9.5% > 2%)
      expect(() =>
        DomainInvariants.assertRebalancingConservation(10000, 9000, 50, 0.02),
      ).toThrow("REBALANCE_CONSERVATION_BREACH");
    });

    it("rejects negative execution fees", () => {
      expect(() =>
        DomainInvariants.assertRebalancingConservation(1000, 1000, -10, 0.02),
      ).toThrow("NEGATIVE_REBALANCE_FEES");
    });
  });

  describe("Invariant 8: Stellar Public Key and Contract Address Format", () => {
    it("accepts valid 56-char Base32 Stellar account and contract keys", () => {
      const validAccount = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const validContract = "CA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

      expect(() =>
        DomainInvariants.assertStellarAddressFormat(validAccount, "account"),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertStellarAddressFormat(validContract, "contract"),
      ).not.toThrow();
    });

    it("rejects malformed address lengths or invalid characters", () => {
      expect(() =>
        DomainInvariants.assertStellarAddressFormat("GTOO_SHORT"),
      ).toThrow("MALFORMED_STELLAR_ADDRESS_LENGTH");

      // Contains invalid characters '8', '9', '0'
      const invalidChars = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZV8";
      expect(() =>
        DomainInvariants.assertStellarAddressFormat(invalidChars),
      ).toThrow("STELLAR_BASE32_INVALID");
    });

    it("rejects account when contract key was expected and vice versa", () => {
      const accountKey = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      expect(() =>
        DomainInvariants.assertStellarAddressFormat(accountKey, "contract"),
      ).toThrow("STELLAR_CONTRACT_PREFIX_INVALID");
    });
  });

  describe("Invariant 9: Audit Trail Completeness & Temporal Monotonicity", () => {
    it("accepts complete audit entries with valid timestamp", () => {
      expect(() =>
        DomainInvariants.assertAuditTrailIntegrity({
          entityId: "portfolio-101",
          actorId: "user-42",
          newStateHash: "hash_abcdef123456",
          timestamp: new Date(),
        }),
      ).not.toThrow();
    });

    it("rejects audit entry with missing actor or entity", () => {
      expect(() =>
        DomainInvariants.assertAuditTrailIntegrity({
          entityId: "",
          actorId: "user-42",
          newStateHash: "hash_123",
          timestamp: new Date(),
        }),
      ).toThrow("AUDIT_MISSING_ENTITY_ID");
    });

    it("rejects audit entry with future timestamp", () => {
      const futureTime = new Date(Date.now() + 60000); // 1 minute in the future
      expect(() =>
        DomainInvariants.assertAuditTrailIntegrity({
          entityId: "portfolio-101",
          actorId: "user-42",
          newStateHash: "hash_123",
          timestamp: futureTime,
        }),
      ).toThrow("AUDIT_FUTURE_TIMESTAMP");
    });
  });

  describe("Invariant 10: Module Registry Lifecycle and Version Compatibility", () => {
    it("allows enabling registered or disabled modules", () => {
      expect(() =>
        DomainInvariants.assertModuleCompatibility("registered", "enabled"),
      ).not.toThrow();

      expect(() =>
        DomainInvariants.assertModuleCompatibility("disabled", "enabled"),
      ).not.toThrow();
    });

    it("blocks enabling deprecated modules", () => {
      expect(() =>
        DomainInvariants.assertModuleCompatibility("deprecated", "enabled"),
      ).toThrow("DEPRECATED_MODULE_ENABLE_BLOCKED");
    });
  });
});
