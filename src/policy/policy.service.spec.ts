import { ConfigService } from "@nestjs/config";
import { PolicyService } from "./policy.service";

describe("PolicyService", () => {
  const policyFor = (values: Record<string, unknown> = {}) =>
    new PolicyService({
      get: <T>(key: string, fallback?: T): T =>
        (values[key] as T | undefined) ?? (fallback as T),
    } as ConfigService);

  it("allows a default-policy trade at the maximum amount", () => {
    const decision = policyFor().evaluateTrade({
      asset: "XLM",
      amount: 100_000,
      side: "buy",
    });

    expect(decision).toEqual({ allowed: true });
  });

  it("rejects a trade just above the configured maximum with an actionable error", () => {
    const decision = policyFor({ TRADING_MAX_ORDER_AMOUNT: 50 }).evaluateTrade({
      asset: "XLM",
      amount: 50.01,
      side: "buy",
    });

    expect(decision).toEqual({
      allowed: false,
      violation: {
        code: "TRADE_AMOUNT_LIMIT_EXCEEDED",
        field: "amount",
        limit: 50,
        message: "Trade amount exceeds the maximum allowed amount of 50.",
      },
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid amount %p",
    (amount) => {
      const decision = policyFor().evaluateTrade({
        asset: "XLM",
        amount,
        side: "sell",
      });

      expect(decision).toMatchObject({
        allowed: false,
        violation: { code: "INVALID_TRADE_AMOUNT", field: "amount" },
      });
    },
  );

  it("applies configured asset and side restrictions case-insensitively", () => {
    const policy = policyFor({
      TRADING_ALLOWED_ASSETS: "xlm, usdc",
      TRADING_ALLOWED_SIDES: "sell",
    });

    expect(
      policy.evaluateTrade({ asset: "XLM", amount: 1, side: "sell" }),
    ).toEqual({ allowed: true });
    expect(
      policy.evaluateTrade({ asset: "BTC", amount: 1, side: "sell" }),
    ).toMatchObject({
      allowed: false,
      violation: { code: "ASSET_NOT_ALLOWED", field: "asset" },
    });
    expect(
      policy.evaluateTrade({ asset: "USDC", amount: 1, side: "buy" }),
    ).toMatchObject({
      allowed: false,
      violation: { code: "TRADE_SIDE_NOT_ALLOWED", field: "side" },
    });
  });

  it("rejects all trading while the policy is disabled", () => {
    const decision = policyFor({ TRADING_ENABLED: false }).evaluateTrade({
      asset: "XLM",
      amount: 1,
      side: "buy",
    });

    expect(decision).toMatchObject({
      allowed: false,
      violation: { code: "TRADING_DISABLED" },
    });
  });
});
