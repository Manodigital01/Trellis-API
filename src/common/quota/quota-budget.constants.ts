/** Injection token for the optional Redis client used by QuotaBudgetService. */
export const QUOTA_BUDGET_REDIS = "QUOTA_BUDGET_REDIS";

/** Prefix for Redis monthly quota counter keys. */
export const QUOTA_REDIS_KEY_PREFIX = "quota";

/** Monthly API call limits per tenant plan tier. */
export const QUOTA_TIRE_LIMITS = {
  free: 10_000,
  pro: 1_000_000,
  enterprise: Number.POSITIVE_INFINITY,
} as const;

export type QuotaTier = keyof typeof QUOTA_TIRE_LIMITS;

/** Fraction of the tier limit at which a soft-limit warning is emitted. */
export const QUOTA_SOFT_LIMIT_RATIO = 0.9;

/** Error code returned when a monthly quota is exhausted. */
export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED";

/** Response header reporting the applicable monthly limit. */
export const QUOTA_LIMIT_HEADER = "X-Quota-Limit";

/** Response header reporting the remaining monthly allowance. */
export const QUOTA_REMAINING_HEADER = "X-Quota-Remaining";

/** Response header reporting the monthly quota reset date (ISO 8601). */
export const QUOTA_RESET_HEADER = "X-Quota-Reset";
