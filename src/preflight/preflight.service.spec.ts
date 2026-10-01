import { ConfigService } from "@nestjs/config";
import { PolicyService } from "src/policy/policy.service";
import { PreflightBlockedException } from "./preflight.errors";
import { PreflightService } from "./preflight.service";
import {
  DefaultPreflightStateProvider,
  PreflightStateProvider,
} from "./preflight.state";
import {
  PreflightOperation,
  PreflightStateSnapshot,
} from "./preflight.types";
import { PreflightRequestDto } from "./dto/preflight-request.dto";

const AS_OF = "2026-09-28T12:00:00.000Z";

function configStub(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

function snapshot(over: Partial<PreflightStateSnapshot> = {}): PreflightStateSnapshot {
  return {
    version: "v1",
    observedAt: AS_OF,
    balances: { XLM: "100" },
    allowances: {},
    consumedDigests: [],
    idempotencyRecords: [],
    verifiedDestinations: [],
    oracle: [],
    ...over,
  };
}

function providerStub(value: PreflightStateSnapshot): PreflightStateProvider {
  return { loadSnapshot: jest.fn().mockReturnValue(value) };
}

function request(
  over: Partial<PreflightRequestDto> = {},
): PreflightRequestDto {
  return {
    kind: "payment_transfer",
    asset: "XLM",
    amount: "10",
    requiresOraclePrice: false,
    stateVersion: "v1",
    asOf: AS_OF,
    ...over,
  } as PreflightRequestDto;
}

describe("PreflightService", () => {
  it("returns success when the provider snapshot has no findings", async () => {
    const provider = providerStub(snapshot());
    const service = new PreflightService(configStub(), provider);

    const result = await service.preflight(request());

    expect(result.status).toBe("success");
    expect(result.findings).toEqual([]);
  });

  it("delegates snapshot assembly to the injected provider", async () => {
    const provider = providerStub(snapshot());
    const service = new PreflightService(configStub(), provider);

    await service.preflight(request());

    expect(provider.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "payment_transfer",
        asset: "XLM",
        amount: "10",
      }),
      expect.objectContaining({ version: "v1", asOf: AS_OF }),
    );
  });

  it("resolves freshness thresholds from configuration and clamps warn to max", () => {
    const service = new PreflightService(
      configStub({
        PREFLIGHT_MAX_SNAPSHOT_AGE_SECONDS: "30",
        PREFLIGHT_WARN_SNAPSHOT_AGE_SECONDS: "120",
        PREFLIGHT_MAX_ORACLE_AGE_SECONDS: "15",
      }),
      providerStub(snapshot()),
    );

    expect(service.resolveThresholds()).toEqual({
      maxSnapshotAgeSeconds: 30,
      warnSnapshotAgeSeconds: 30,
      maxOracleAgeSeconds: 15,
    });
  });

  it("asserts a blocking result by throwing the standard error envelope", async () => {
    const provider = providerStub(snapshot({ balances: { XLM: "1" } }));
    const service = new PreflightService(configStub(), provider);

    const result = await service.preflight(request({ amount: "10" }));
    expect(result.status).toBe("blocking");

    let thrown: PreflightBlockedException;
    try {
      service.assertProceedable(result);
    } catch (error) {
      thrown = error as PreflightBlockedException;
    }

    expect(thrown).toBeInstanceOf(PreflightBlockedException);
    expect(thrown.preflightId).toBe(result.preflightId);
    expect(thrown.findings).toEqual(result.findings);
    expect(thrown.getStatus()).toBe(422);
    expect(thrown.errorCode).toBe("PRECONDITION_FAILED");
  });

  it("returns the result unchanged from assertProceedable when not blocking", async () => {
    const service = new PreflightService(
      configStub(),
      providerStub(snapshot()),
    );

    const result = await service.preflight(request());
    expect(service.assertProceedable(result)).toBe(result);
  });
});

describe("DefaultPreflightStateProvider", () => {
  function policyStub() {
    return { evaluateTrade: jest.fn().mockReturnValue({ allowed: true }) };
  }

  it("asks the policy service for the decision of trades", () => {
    const policy = policyStub();
    const provider = new DefaultPreflightStateProvider(
      policy as unknown as PolicyService,
    );

    const snapshotValue = provider.loadSnapshot(
      { kind: "trade", asset: "XLM", amount: "10", side: "buy" },
      { version: "v1", asOf: AS_OF },
    );

    expect(policy.evaluateTrade).toHaveBeenCalledWith({
      asset: "XLM",
      amount: 10,
      side: "buy",
    });
    expect(snapshotValue.policyDecision).toEqual({ allowed: true });
  });

  it("does not consult the policy service for non-trade operations", () => {
    const policy = policyStub();
    const provider = new DefaultPreflightStateProvider(
      policy as unknown as PolicyService,
    );

    const snapshotValue = provider.loadSnapshot(
      { kind: "payment_transfer", asset: "XLM", amount: "10" },
      { version: "v1", asOf: AS_OF },
    );

    expect(policy.evaluateTrade).not.toHaveBeenCalled();
    expect(snapshotValue.policyDecision).toBeUndefined();
  });

  it("defaults observedAt to the evaluation instant and carries state through", () => {
    const provider = new DefaultPreflightStateProvider(
      policyStub() as unknown as PolicyService,
    );

    const snapshotValue = provider.loadSnapshot(
      { kind: "payment_transfer", asset: "XLM", amount: "10" },
      {
        version: "v9",
        asOf: AS_OF,
        state: { balances: { XLM: "42" }, consumedDigests: ["digest-a"] },
      },
    );

    expect(snapshotValue.version).toBe("v9");
    expect(snapshotValue.observedAt).toBe(AS_OF);
    expect(snapshotValue.balances).toEqual({ XLM: "42" });
    expect(snapshotValue.consumedDigests).toEqual(["digest-a"]);
  });
});
