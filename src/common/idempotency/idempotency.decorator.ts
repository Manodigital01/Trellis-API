import { SetMetadata } from "@nestjs/common";
import { IDEMPOTENCY_OPTIONS } from "./idempotency.constants";

export interface IdempotentOptions {
  /**
   * When true, a mutating request without an `Idempotency-Key` header is
   * rejected with 400 instead of being processed unprotected.
   */
  required?: boolean;
  /** Overrides `IDEMPOTENCY_TTL_SECONDS` for this route. */
  ttlSeconds?: number;
  /** Overrides the derived `METHOD:/route:actor` scope. */
  scope?: string;
}

/**
 * Marks a handler (or controller) as a high-risk write operation that must be
 * protected by replay checks.
 *
 * @example
 * ```ts
 * @Post("withdrawals")
 * @Idempotent({ required: true })
 * initiateWithdrawal(@Body() dto: CreateWithdrawalDto) { ... }
 * ```
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENCY_OPTIONS, options);
