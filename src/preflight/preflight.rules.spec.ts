import {
  buildOperationDigest,
  defaultPreflightThresholds,
  evaluatePreflight,
} from "./preflight.rules";
import {
  PreflightOperation,
  PreflightResult,
  PreflightStateSnapshot,
  PreflightThresholds,
} from "./preflight.types";

const AS_OF = "2026-09-28T12:00:00.000Z";
const FRESH = "2026-09-28T11:59:30.000Z";

function thresholds(over: Partial<PreflightThresholds> = {}): PreflightThresholds {
  return { ...defaultPreflightThresholds(), ...over };
}

function snapshot(over: Partial<PreflightStateSnapshot> = {}): PreflightStateSnapshot {
  return {
    version: "v1",
    observedAt: FRESH,
    balances: { XLM: "100" },
    allowances: {},
    consumedDigests: [],
    idempotencyRecords: [],
    verifiedDestinations: [],
    oracle: [],
    ...over,
  };
}

function operation(over: Partial<PreflightOperation> = {}): PreflightOperation {
  return {
    kind: "payment_transfer",
    asset: "xlm",
    amount: "10",
    requiresOraclePrice: false,
    ...over,
  };
}

function run(
  op: PreflightOperation,
  snap: PreflightStateSnapshot,
  over: { asOf?: string; thresholds?: Partial<PreflightThresholds> } = {},
): PreflightResult {
  return evaluatePreflight({
    operation: op,
    snapshot: snap,
    thresholds: thresholds(over.thresholds),
    asOf: over.asOf ?? AS_OF,
  });
}

describe("evaluatePreflight", () => {
  it("returns success with no findings when every rule passes", () => {
    const result = run(operation(), snapshot());

    expect(result.status).toBe("success");
    expect(result.findings).toEqual([]);
    expect(result.blockingCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.preflightId).toMatch(/^pf:payment_transfer:[0-9a-f]{32}$/);
  });

  it("returns a warning with user-safe explanation and remediation", () => {
    const result = run(
      operation({ amount: "10", estimatedFee: "1" }),
      snapshot({ balances: { XLM: "10.5" } }),
    );

    expect(result.status).toBe("warning");
    const finding = result.findings.find((f) => f.code === "FEE_BUFFER_EXHAUSTED");
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("warning");
    expect(finding.remediation).toEqual(expect.any(String));
    expect(finding.message).toContain("10.5");
    expect(finding.details).toMatchObject({ shortfall: "0.5" });
  });

  it("blocks an operation that exceeds the available balance", () => {
    const result = run(operation({ amount: "200" }), snapshot());

    expect(result.status).toBe("blocking");
    const finding = result.findings.find((f) => f.code === "INSUFFICIENT_BALANCE");
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("blocking");
    expect(finding.details).toMatchObject({
      amount: "200",
      available: "100",
      shortfall: "100",
    });
  });

  it("blocks when the asset balance is not part of the snapshot", () => {
    const result = run(operation({ asset: "USDC" }), snapshot());

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "BALANCE_STATE_UNAVAILABLE" }),
    );
  });

  it("treats a snapshot older than the freshness limit as stale and blocking", () => {
    const result = run(operation(), snapshot(), {
      asOf: "2026-09-28T12:10:00.000Z",
    });

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "STATE_SNAPSHOT_STALE" }),
    );
  });

  it("warns when a snapshot is aging but still within the freshness limit", () => {
    const result = run(operation(), snapshot(), {
      asOf: "2026-09-28T12:01:15.000Z",
    });

    expect(result.status).toBe("warning");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "STATE_SNAPSHOT_AGING" }),
    );
    expect(result.findings.some((f) => f.code === "STATE_SNAPSHOT_STALE")).toBe(
      false,
    );
  });

  it("blocks a duplicate operation already consumed for the account", () => {
    const digest = buildOperationDigest(operation());
    const result = run(operation(), snapshot({ consumedDigests: [digest] }));

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_OPERATION" }),
    );
  });

  it("blocks an idempotency key reused for a different payload", () => {
    const result = run(
      operation({ idempotencyKey: "key-12345678" }),
      snapshot({
        idempotencyRecords: [
          { key: "key-12345678", requestDigest: "different", status: "completed" },
        ],
      }),
    );

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    );
  });

  it("reports an idempotent replay as info without changing success", () => {
    const op = operation({ idempotencyKey: "key-12345678" });
    const result = run(
      op,
      snapshot({
        idempotencyRecords: [
          {
            key: "key-12345678",
            requestDigest: buildOperationDigest(op),
            status: "completed",
          },
        ],
      }),
    );

    expect(result.status).toBe("success");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "IDEMPOTENT_REPLAY", severity: "info" }),
    );
  });

  it("blocks an expired operation", () => {
    const result = run(
      operation({ expiresAt: "2026-09-28T11:00:00.000Z" }),
      snapshot(),
    );

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "OPERATION_EXPIRED" }),
    );
  });

  it("blocks when the prepared state version no longer matches", () => {
    const result = run(
      operation({ expectedStateVersion: "v0" }),
      snapshot({ version: "v1" }),
    );

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "STATE_VERSION_MISMATCH" }),
    );
  });

  it("blocks when the amount exceeds the approved allowance", () => {
    const result = run(operation(), snapshot({ allowances: { XLM: "5" } }));

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "INSUFFICIENT_ALLOWANCE" }),
    );
  });

  it("maps a policy violation for trades onto a blocking finding", () => {
    const result = run(
      operation({ kind: "trade", asset: "XLM", amount: "1", side: "buy" }),
      snapshot({
        oracle: [{ asset: "XLM", price: "0.1", updatedAt: FRESH }],
        policyDecision: {
          allowed: false,
          violation: {
            code: "TRADE_AMOUNT_LIMIT_EXCEEDED",
            message: "Trade amount exceeds the maximum allowed amount of 50.",
            field: "amount",
            limit: 50,
          },
        },
      }),
    );

    expect(result.status).toBe("blocking");
    const finding = result.findings.find(
      (f) => f.code === "TRADE_AMOUNT_LIMIT_EXCEEDED",
    );
    expect(finding).toBeDefined();
    expect(finding.errorCode).toBe("RISK_LIMIT_EXCEEDED");
    expect(finding.remediation).toContain("50");
  });

  it("blocks a trade whose oracle price is stale", () => {
    const result = run(
      operation({ kind: "trade", asset: "XLM", amount: "1", side: "buy" }),
      snapshot({
        oracle: [
          { asset: "XLM", price: "0.1", updatedAt: "2026-09-28T11:50:00.000Z" },
        ],
        policyDecision: { allowed: true },
      }),
    );

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "ORACLE_PRICE_STALE" }),
    );
  });

  it("warns about an unverified destination without blocking", () => {
    const result = run(
      operation({ destination: "GUNKNOWN" }),
      snapshot({ verifiedDestinations: ["GKNOWN"] }),
    );

    expect(result.status).toBe("warning");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "DESTINATION_NOT_VERIFIED" }),
    );
  });

  it("orders findings by severity, blocking first", () => {
    const result = run(
      operation({ amount: "200", destination: "GUNKNOWN" }),
      snapshot({ verifiedDestinations: ["GKNOWN"] }),
    );

    expect(result.status).toBe("blocking");
    const rank = { blocking: 0, warning: 1, info: 2 } as const;
    const severities = result.findings.map((f) => rank[f.severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  it("does not throw and blocks when the amount is not a decimal string", () => {
    const result = run(operation({ amount: "not-a-number" }), snapshot());

    expect(result.status).toBe("blocking");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "INVALID_OPERATION_AMOUNT" }),
    );
  });

  describe("determinism", () => {
    const build = () =>
      evaluatePreflight({
        operation: operation({ amount: "10.0" }),
        snapshot: snapshot({
          oracle: [
            { asset: "xlm", price: "0.1", updatedAt: FRESH },
            { asset: "BTC", price: "50000", updatedAt: FRESH },
          ],
          consumedDigests: ["b", "a", "a"],
          verifiedDestinations: ["GDEST2", "GDEST1"],
        }),
        thresholds: thresholds(),
        asOf: AS_OF,
      });

    it("returns an identical result and digest for identical input", () => {
      const first = build();
      const second = build();

      expect(second).toEqual(first);
      expect(second.preflightId).toBe(first.preflightId);
      expect(second.digest).toBe(first.digest);
    });

    it("is independent of snapshot array ordering", () => {
      const ordered = build();
      const reversed = evaluatePreflight({
        operation: operation({ amount: "10" }),
        snapshot: snapshot({
          oracle: [
            { asset: "BTC", price: "50000", updatedAt: FRESH },
            { asset: "XLM", price: "0.1", updatedAt: FRESH },
          ],
          consumedDigests: ["a", "b"],
          verifiedDestinations: ["GDEST1", "GDEST2"],
        }),
        thresholds: thresholds(),
        asOf: AS_OF,
      });

      expect(reversed.preflightId).toBe(ordered.preflightId);
      expect(reversed.digest).toBe(ordered.digest);
    });
  });
});
