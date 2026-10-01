import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EXPENSIVE_OPERATION_RULES,
  PRIVILEGED_ROLES,
  ExpensiveOpRule,
} from './expensive-ops.rules';

export interface ExpensiveOpDecision {
  allowed: boolean;
  operationKey: string;
  limit: number;
  remaining: number;
  resetAt: number;       // Unix ms
  retryAfterMs?: number;
  privileged: boolean;
  scope: string;
}

export interface NearLimitWarning {
  operationKey: string;
  userId: string;
  remaining: number;
  limit: number;
  windowMs: number;
  warnedAt: number;
}

interface BucketState {
  count: number;
  windowStart: number;
}

@Injectable()
export class ExpensiveOpsRateLimiterService {
  private readonly logger = new Logger(ExpensiveOpsRateLimiterService.name);

  // In-process store (Redis-backed in production via RateLimiterService).
  // Keyed by `userId:operationKey`
  private readonly buckets = new Map<string, BucketState>();

  // Near-limit warnings emitted once per window
  private readonly warnedKeys = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Check whether a user may execute an expensive operation.
   * Automatically records the attempt if allowed.
   */
  check(operationKey: string, userId: string, roles: string[]): ExpensiveOpDecision {
    const rule = this.findRule(operationKey);
    if (!rule) {
      // Unknown key — allow through; don't block unknown operations silently
      this.logger.warn(`Unknown expensive operation key: ${operationKey}`);
      return this.buildDecision(true, operationKey, 1000, 999, Date.now() + 60_000, false);
    }

    const privileged = roles.some(r => PRIVILEGED_ROLES.includes(r));
    const effectiveLimit = privileged
      ? rule.limit * rule.privilegedMultiplier
      : rule.limit;

    const key = `${userId}:${operationKey}`;
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStart >= rule.windowMs) {
      bucket = { count: 0, windowStart: now };
    }

    const resetAt = bucket.windowStart + rule.windowMs;

    if (bucket.count >= effectiveLimit) {
      const retryAfterMs = resetAt - now;
      this.logger.warn(
        `Rate limit exceeded — op=${operationKey} user=${userId} count=${bucket.count}/${effectiveLimit}`,
      );
      this.buckets.set(key, bucket);
      return this.buildDecision(false, operationKey, effectiveLimit, 0, resetAt, privileged, retryAfterMs);
    }

    bucket.count++;
    this.buckets.set(key, bucket);

    const remaining = effectiveLimit - bucket.count;

    // Near-limit observability: warn once per window when ≤10% remaining
    const warnKey = `${key}:${bucket.windowStart}`;
    if (remaining <= Math.ceil(effectiveLimit * 0.1) && !this.warnedKeys.has(warnKey)) {
      this.warnedKeys.add(warnKey);
      this.logger.warn(
        `Near rate-limit — op=${operationKey} user=${userId} remaining=${remaining}/${effectiveLimit}`,
      );
    }

    return this.buildDecision(true, operationKey, effectiveLimit, remaining, resetAt, privileged);
  }

  /** Reset a user's bucket for a given operation (e.g. after legitimate retry). */
  resetBucket(operationKey: string, userId: string): void {
    this.buckets.delete(`${userId}:${operationKey}`);
  }

  /** Return current usage snapshot for observability/dashboard. */
  getUsageSnapshot(userId?: string): Record<string, BucketState & { operationKey: string; userId: string }> {
    const out: Record<string, BucketState & { operationKey: string; userId: string }> = {};
    for (const [k, v] of this.buckets.entries()) {
      const [uid, opKey] = k.split(':');
      if (!userId || uid === userId) {
        out[k] = { ...v, operationKey: opKey, userId: uid };
      }
    }
    return out;
  }

  getRules(): ExpensiveOpRule[] {
    return EXPENSIVE_OPERATION_RULES;
  }

  private findRule(key: string): ExpensiveOpRule | undefined {
    return EXPENSIVE_OPERATION_RULES.find(r => r.operationKey === key);
  }

  private buildDecision(
    allowed: boolean,
    operationKey: string,
    limit: number,
    remaining: number,
    resetAt: number,
    privileged: boolean,
    retryAfterMs?: number,
  ): ExpensiveOpDecision {
    return { allowed, operationKey, limit, remaining, resetAt, privileged, retryAfterMs, scope: operationKey };
  }
}
