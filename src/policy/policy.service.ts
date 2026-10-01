import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PolicyDecision,
  PolicyViolationCode,
  TradePolicyInput,
  TradeSide,
  TradingPolicy,
} from "./policy.types";

const DEFAULT_TRADING_POLICY: TradingPolicy = {
  enabled: true,
  maxOrderAmount: 100_000,
  allowedSides: ["buy", "sell"],
};

@Injectable()
export class PolicyService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Evaluates trade business rules in one place. The returned decision is safe
   * to expose to API clients and deliberately contains no account information.
   */
  evaluateTrade(input: TradePolicyInput): PolicyDecision {
    const policy = this.getTradingPolicy();

    if (!policy.enabled) {
      return this.reject("TRADING_DISABLED", "asset", "Trading is temporarily unavailable.");
    }

    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return this.reject(
        "INVALID_TRADE_AMOUNT",
        "amount",
        "Trade amount must be greater than zero.",
      );
    }

    if (input.amount > policy.maxOrderAmount) {
      return this.reject(
        "TRADE_AMOUNT_LIMIT_EXCEEDED",
        "amount",
        `Trade amount exceeds the maximum allowed amount of ${policy.maxOrderAmount}.`,
        { limit: policy.maxOrderAmount },
      );
    }

    const asset = input.asset.trim().toUpperCase();
    if (policy.allowedAssets && !policy.allowedAssets.includes(asset)) {
      return this.reject(
        "ASSET_NOT_ALLOWED",
        "asset",
        "This asset is not available for trading.",
        { allowedValues: policy.allowedAssets },
      );
    }

    if (!policy.allowedSides.includes(input.side as TradeSide)) {
      return this.reject(
        "TRADE_SIDE_NOT_ALLOWED",
        "side",
        "This trade side is not available.",
        { allowedValues: policy.allowedSides },
      );
    }

    return { allowed: true };
  }

  getTradingPolicy(): TradingPolicy {
    const configuredLimit = this.configService.get<number>(
      "TRADING_MAX_ORDER_AMOUNT",
      DEFAULT_TRADING_POLICY.maxOrderAmount,
    );
    const configuredAssets = this.readList("TRADING_ALLOWED_ASSETS");
    const configuredSides = this.readList("TRADING_ALLOWED_SIDES") as TradeSide[];

    return {
      enabled: this.configService.get<boolean>(
        "TRADING_ENABLED",
        DEFAULT_TRADING_POLICY.enabled,
      ),
      maxOrderAmount:
        Number.isFinite(configuredLimit) && configuredLimit > 0
          ? configuredLimit
          : DEFAULT_TRADING_POLICY.maxOrderAmount,
      allowedAssets: configuredAssets.length ? configuredAssets : undefined,
      allowedSides: configuredSides.length
        ? configuredSides
        : DEFAULT_TRADING_POLICY.allowedSides,
    };
  }

  private readList(key: string): string[] {
    const value = this.configService.get<string>(key, "");
    return value
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  }

  private reject(
    code: PolicyViolationCode,
    field: "asset" | "amount" | "side",
    message: string,
    details: { limit?: number; allowedValues?: string[] } = {},
  ): PolicyDecision {
    return { allowed: false, violation: { code, field, message, ...details } };
  }
}
