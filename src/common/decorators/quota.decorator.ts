import { SetMetadata, applyDecorators } from "@nestjs/common";
import type { ResourceKey } from "../quota/quota-budget.service";

/**
 * Metadata key consumed by QuotaEnforcementGuard.
 * Carries the quota enforcement options for a route or controller.
 */
export const QUOTA_ENFORCE_KEY = Symbol("QUOTA_ENFORCE_OPTIONS");

export interface QuotaEnforceOptions {
  /** Which resource bucket to charge. */
  resource: ResourceKey;
  /**
   * Tenant plan tier used to resolve the monthly API call limit.
   * Free: 10k, Pro: 1M, Enterprise: unlimited.
   */
  tier?: "free" | "pro" | "enterprise";
  /**
   * Fixed cost per request.  For variable-cost operations (e.g. AI tokens)
   * leave this undefined and call QuotaBudgetService.consume() directly in
   * the service layer, passing the actual cost after the operation completes.
   */
  cost?: number;
  /**
   * When true, the guard allows the request even when the quota is exceeded
   * and merely logs a warning.  Useful for soft-limits on non-critical paths.
   */
  soft?: boolean;
  /**
   * When true, the guard emits X-Quota-Limit / X-Quota-Remaining headers
   * and returns 429 QUOTA_EXCEEDED once the monthly tier limit is exhausted.
   */
  enforceMonthly?: boolean;
}

/**
 * Apply quota enforcement to a controller method or class.
 *
 * Usage:
 *   @EnforceQuota({ resource: 'compute:job', cost: 1 })
 *   async submitJob() { ... }
 *
 *   @EnforceQuota({ resource: 'ai:tokens', soft: true })
 *   async chat() { ... }
 */
export function EnforceQuota(options: QuotaEnforceOptions) {
  return applyDecorators(SetMetadata(QUOTA_ENFORCE_KEY, options));
}
