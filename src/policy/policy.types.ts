export type TradeSide = "buy" | "sell";

/** The input required to make a business-policy decision about a trade. */
export interface TradePolicyInput {
  asset: string;
  amount: number;
  side: TradeSide | string;
}

export type PolicyViolationCode =
  | "TRADING_DISABLED"
  | "INVALID_TRADE_AMOUNT"
  | "TRADE_AMOUNT_LIMIT_EXCEEDED"
  | "ASSET_NOT_ALLOWED"
  | "TRADE_SIDE_NOT_ALLOWED";

export interface PolicyViolation {
  code: PolicyViolationCode;
  message: string;
  field: "asset" | "amount" | "side";
  limit?: number;
  allowedValues?: string[];
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; violation: PolicyViolation };

export interface TradingPolicy {
  enabled: boolean;
  maxOrderAmount: number;
  allowedAssets?: string[];
  allowedSides: TradeSide[];
}
