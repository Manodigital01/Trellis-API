/**
 * QuotaBudgetService — per-user budget ledger for expensive operations.
 *
 * Unlike the per-minute rate limiter (DistributedRateLimitGuard), this service
 * tracks cumulative spend of "cost units" over a rolling or fixed window, making
 * it suitable for operations whose cost varies (AI token consumption, oracle gas,
 * storage writes, heavy compute jobs).
 *
 * Architecture
 * ─────────────
 * - Redis is the authoritative store.  In-memory fallback (Map) is used when
 *   Redis is unavailable so the app continues to run (with reduced enforcement).
 * - A "budget" is keyed by (actor, resource).  actor = userId | walletAddress | ip.
 * - Cost units are arbitrary numbers defined per-operation.
 * - Maintainers can inspect usage via QuotaBudgetService.getUsageSummary().
 *
 * Issue: #65
 */

import { Injectable, Logger, Optional, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type Redis from "ioredis";
import { QUOTA_BUDGET_REDIS } from "./quota-budget.constants";

export type ResourceKey =
  | "ai:tokens"       // OpenAI / Grok / Llama token spend (per 1k tokens = 1 unit)
  | "oracle:submit"   // on-chain oracle payload submission
  | "storage:upload"  // file upload (per MB = 1 unit)
  | "compute:job"     // background compute job submission
  | "search:query"     // Elasticsearch heavy query
  | "portfolio:backtest" // backtesting job
  | string;           // allow extension via string literal union

export interface QuotaPolicy {
  resource: ResourceKey;
  /** Maximum cost units allowed per window. */
  limit: number;
  /** Rolling window size in milliseconds. Default 3_600_000 (1 h). */
  windowMs: number;
  /** Human-readable description shown in error messages. */
  description: string;
}

export interface QuotaConsumeResult {
  allowed: boolean;
  resource: ResourceKey;
  actor: string;
  consumed: number;
  total: number;
  limit: number;
  remaining: number;
  resetAt: Date;
  /** When allowed is false, a human-friendly error message with remediation. */
  message?: string;
}

export interface UsageSummaryEntry {
  actor: string;
  resource: ResourceKey;
  total: number;
  limit: number;
  remaining: number;
  resetAt: Date;
  utilizationPct: number;
}

// Default policies (can be overridden via env vars at inject time)
export const DEFAULT_QUOTA_POLICIES: QuotaPolicy[] = [
  {
    resource: "ai:tokens",
    limit: 500,         // 500k tokens / hour
    windowMs: 3_300_000,
    description: "AI token usage (per 1,000 tokens = 1 unit)",
  },
  {
    resource: "oracle:submit",
    limit: 50,
    windowMs: 3_600_000,
    description: "Oracle payload submissions per hour",
  },
  {
    resource: "storage:upload",
    limit: 500,         // 500 MB / hour
    windowMs: 3_300_000,
    description: "File upload quota (per MB = 1 unit)",
  },
  {
    resource: "compute:job",
    limit: 100,
    windowMs: 3_300_000,
    description: "Background compute job submissions per hour",
  },
  {
    resource: "search:query",
    limit: 1000,
    windowMs: 3_300_000,
    description: "Elasticsearch query quota per hour",
  },
  {
    resource: "portfolio:backtest",
    limit: 20,
    windowMs: 3_300_000,
    description: "Portfolio backtest runs per hour",
  },
];

// Tier-based monthly API call quota limits (as defined in the issue)
export const DEFAULT_TIER_LIMITS: Record<string, number> = {
  free: 10_000,
  pro: 1_000_000,
  enterprise: Infinity,
};

const REDIS_KEY_PREFIX = "trellis:quota:";
const MONTHLY_KEY_PREFIX = "quota:";

@Injectable()
export class QuotaBudgetService {
  private readonly logger = new Logger(QuotaBudgetService.name);
  private readonly policies = new Map<ResourceKey, QuotaPolicy>();
  /** In-memory fallback when Redis is unavailable */
  private readonly memStore = new Map<string, { total: number; resetAt: number }>();
  private lastMemCleanup = Date.now();
  /** Tier limits map (tier name -> monthly call limit) */
  private readonly tierLimits: Record<string, number>;

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(QUOTA_BUDGET_REDIS) private readonly redis: Redis | null,
  ) {
    for (const policy of DEFAULT_QUOTA_POLICIES) {
      this.policies.set(policy.resource, policy);
    }
    this.tierLimits = { ...DEFAULT_TIER_LIMITS };
  }

  /**
   * Register or override a quota policy at runtime.
   * Useful for per-tenant overrides or operator-granted increases.
   */
  registerPolicy(policy: QuotaPolicy): void {
    this.policies.set(policy.resource, policy);
  }

  getPolicy(resource: ResourceKey): QuotaPolicy | undefined {
    return this.policies.get(resource);
  }

  /** All registered policies */
  listPolicies(): QuotaPolicy[] {
    return [...this.policies.values()];
  }

  /** Register or override a tier's monthly limit. */
  registerTierLimit(tier: string, limit: number): void {
    this.tierLimits[tier.toLowerCase()] = limit;
  }

  /** Return the monthly limit for a given tier. */
  getTierLimit(tier: string): number {
    return this.tierLimits[tier.toLowerCase()] ?? this.tierLimits.free;
  }

  /** All registered tier limits. */
  listTierLimits(): Record<string, number> {
    return { ...this.tierLimits };
  }

  /**
   * Attempt to consume `cost` units from `actor`'s budget for `resource`.
   *
   * Designed to be called inside a guard or service before executing an
   * expensive operation.  Returns QuotaConsumeResult with `allowed: false`
   * (and a remediation message) rather than throwing — callers decide whether
   * to reject or log-and-allow based on their policy.
   */
  async consume(
    resource: ResourceKey,
    actor: string,
    cost = 1,
  ): Promise<QuotaConsumeResult> {
    const policy = this.policies.get(resource);
    if (!policy) {
      // No policy configured → allow by default
      return {
        allowed: true,
        resource,
        actor,
        consumed: cost,
        total: cost,
        limit: Infinity,
        remaining: Infinity,
        resetAt: new Date(Date.now() + 3_600_000),
      };
    }

    const { total, resetAt } = await this.increment(
      actor,
      resource,
      cost,
      policy.windowMs,
    );

    const remaining = Math.max(0, policy.limit - total);
    const allowed = total <= policy.limit;

    return {
      allowed,
      resource,
      actor,
      consumed: cost,
      total,
      limit: policy.limit,
      remaining,
      resetAt: new Date(resetAt),
      message: allowed
        ? undefined
        : `Quota exceeded for ${policy.description}. ` +
          `You have used ${total}/${policy.limit} units. ` +
          `Quota resets at ${new Date(resetAt).toISOString()}. ` +
          `To request a limit increase, contact your administrator.`,
    };
  }

  /**
   * Check current usage without consuming (dry-run).
   */
  async peek(resource: ResourceKey, actor: string): Promise<QuotaConsumeResult> {
    const policy = this.policies.get(resource);
    if (!policy) {
      return {
        allowed: true,
        resource,
        actor,
        consumed: 0,
        total: 0,
        limit: Infinity,
        remaining: Infinity,
        resetAt: new Date(Date.now() + 3_600_000),
      };
    }

    const key = this.buildKey(actor, resource);
    const { total, resetAt } = await this.getCurrentState(key, policy.windowMs);
    const remaining = Math.max(0, policy.limit - total);

    return {
      allowed: total < policy.limit,
      resource,
      actor,
      consumed: 0,
      total,
      limit: policy.limit,
      remaining,
      resetAt: new Date(resetAt),
    };
  }

  /**
   * Manually reset quota for an actor (admin / operator override).
   */
  async resetQuota(resource: ResourceKey, actor: string): Promise<void> {
    const key = this.buildKey(actor, resource);
    if (this.redis) {
      try {
        await this.redis.del(key);
        return;
      } catch (err) {
        this.logger.warn({ err }, "Redis reset failed, falling back to memory");
      }
    }
    this.memStore.delete(key);
  }

  /**
   * Fetch usage across all known actors for a given resource.
   * Intended for maintainer diagnostics — never expose to end users directly.
   */
  async getUsageSummary(resource: ResourceKey): Promise<UsageSummaryEntry[]> {
    const policy = this.policies.get(resource);
    const limit = policy?.limit ?? Infinity;
    const windowMs = policy?.windowMs ?? 3_600_000;

    if (this.redis) {
      try {
        const pattern = `${REDIS_KEY_PREFIX}*:${resource}`;
        const keys = await this.redis.keys(pattern);
        const entries: UsageSummaryEntry[] = [];

        for (const key of keys) {
          const { total, resetAt } = await this.getCurrentState(key, windowMs);
          const actor = key
            .replace(REDIS_KEY_PREFIX, "")
            .replace(`:${resource}`, "");
          entries.push({
            actor,
            resource,
            total,
            limit,
            remaining: Math.max(0, limit - total),
            resetAt: new Date(resetAt),
            utilizationPct: isFinite(limit) ? (total / limit) * 100 : 0,
          });
        }
        return entries.sort((a, b) => b.total - a.total);
      } catch (err) {
        this.logger.warn({ err }, "Redis usage summary failed, using memory store");
      }
    }

    // Memory fallback
    const now = Date.now();
    return [...this.memStore.entries()]
      .filter(([i, v]) => k.endsWith(`:${resource}`) && v.resetAt > now)
      .map(([k, v]) => {
        const actor = k.replace(`:${resource}`, "");
        return {
          actor,
          resource,
          total: v.total,
          limit,
          remaining: Math.max(0, limit - v.total),
          resetAt: new Date(v.resetAt),
          utilizationPct: isFinite(limit) ? (v.total / limit) * 100 : 0,
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  // ------------------------------------------------------------------
  // Monthly tier-based API call quota enforcement
  // ------------------------------------------------------------------

  /**
   * Increment the monthly API call counter for an API key and return the
   * current usage along with the tier limit and reset date.
   *
   * Redis key format: `quota:{apiKey}:{YYYY-MM}` (as required by the issue).
   * The key expires at the end of the current month so the counter resets
   * automatically on the first day of the next month.
   */
  async incrementMonthlyUsage(
    apiKey: string,
    tier = "free",
  ): Promise<{
    total: number;
    limit: number;
    remaining: number;
    resetAt: Date;
    exceeded: boolean;
  }> {
    const limit = this.getTierLimit(tier);
    const key = this.buildMonthlyKey(apiKey);
    const resetAt = this.getMonthEnd();

    // Enterprise = unlimited: still track usage but never reject.
    if (!isFinite(limit)) {
      const total = await this.incrementRaw(key, 1, resetAt);
      return {
        total,
        limit: Infinity,
        remaining: Infinity,
        resetAt,
        exceeded: false,
      };
    }

    const total = await this.incrementRaw(key, 1, resetAt);
    const remaining = Math.max(0, limit - total);
    const exceeded = total > limit;

    return { total, limit, remaining, resetAt, exceeded };
  }

  /**
   * Read the current monthly usage without incrementing (dry-run).
   */
  async getMonthlyUsage(
    apiKey: string,
    tier = "free",
  ): Promise<{
    total: number;
    limit: number;
    remaining: number;
    resetAt: Date;
    exceeded: boolean;
  }> {
    const limit = this.getTierLimit(tier);
    const key = this.buildMonthlyKey(apiKey);
    const resetAt = this.getMonthEnd();
    const total = await this.getRawValue(key);
    const remaining = isFinite(limit)
      ? Math.max(0, limit - total)
      : Infinity;
    const exceeded = isFinite(limit) ? total > limit : false;

    return { total, limit, remaining, resetAt, exceeded };
  }

  /**
   * Reset the monthly counter for an API key (admin / operator override).
   */
  async resetMonthlyUsage(apiKey: string): Promise<void> {
    const key = this.buildMonthlyKey(apiKey);
    if (this.redis) {
      try {
        await this.redis.del(key);
        return;
      } catch (err) {
        this.logger.warn({ err }, "Redis monthly reset failed, falling back to memory");
      }
    }
    this.memStore.delete(key);
  }

  /**
   * Build the Redis key for a given API key and the current month.
   * Format: `quota:{apiKey}:{YYYY-MM}`
   */
  buildMonthlyKey(apiKey: string, date = new Date()): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${MONTHLY_KEY_PREFIX}${apiKey}:${yyyy}-${mm}`;
  }

  /**
   * Return the date when the current monthly quota window resets (00:00 UTC on
   * the first day of the next month).
   */
  getMonthEnd(date = new Date()): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private buildKey(actor: string, resource: ResourceKey): string {
    return `${REDIS_KEY_PREFIX}${actor}:${resource}`;
  }

  private async increment(
    actor: string,
    resource: ResourceKey,
    cost: number,
    windowMs: number,
  ): Promise<{ total: number; resetAt: number }> {
    const key = this.buildKey(actor, resource);

    if (this.redis) {
      try {
        return await this.redisIncrement(key, cost, windowMs);
      } catch (err) {
        this.logger.warn({ err }, "Redis quota increment failed, falling back to memory");
      }
    }

    return this.memIncrement(key, cost, windowMs);
  }

  /**
   * Atomic increment for the monthly counter.  Uses Redis when available,
   * otherwise falls back to the in-memory store.  The key expires at the
   * month boundary so the counter automatically resets.
   */
  private async incrementRaw(
    key: string,
    cost: number,
    resetAt: Date,
  ): Promise<number> {
    const ttlSec = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

    if (this.redis) {
      try {
        const pipeline = this.redis.pipeline();
        pipeline.incrby(this.redisKey(key), cost);
        pipeline.ptl();i
        const results = (await pipeline.exec()) as [
          [null, number],
          [null, number],
        ];
        const total = results[0][1] ?? cost;
        const ptl = results[1][1];
        if (ptl === -1) {
          await this.redis.expire(this.redisKey(key), ttlSec);
        }
        return total;
      } catch (err) {
        this.logger.warn({ err }, "Redis monthly increment failed, falling back to memory");
      }
    }

    return this.memIncrement(key, cost, resetAt.getTime() - Date.now()).total;
  }

  /** Read a raw counter value without incrementing. */
  private async getRawValue(key: string): Promise<number> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.redisKey(key));
        return raw ? parseInt(raw, 10) : 0;
      } catch (err) {
        this.logger.warn({ err }, "Redis monthly read failed, falling back to memory");
      }
    }
    const entry = this.memStore.get(key);
    if (!entry || entry.resetAt <= Date.now()) return 0;
    return entry.total;
  }

  /** Prefix the monthly key with the internal Redis namespace. */
  private redisKey(key: string): string {
    return `${REDIS_KEY_PREFIX}${key}`;
  }

  private async redisIncrement(
    key: string,
    cost: number,
    windowMs: number,
  ): Promise<{ total: number; resetAt: number }> {
    const windowSec = Math.ceil(windowMs / 1000);
    // Atomic increment + expiry in a pipeline
    const pipeline = this.redis!.pipeline();
    pipeline.incrby(key, cost);
    pipeline.pttl(key);
    const [[, total], [, pttl]] = (await pipeline.exec()) as [
      [null, number],
      [null, number],
    ];

    // Set expiry only on first increment (when pttl is -1 = no expiry set)
    if (pttl === -1) {
      await this.redis!.expire(key, windowSec);
    }

    const resetAt =
      pttl > 0 ? Date.now() + pttl : Date.now() + windowMs;

    return { total: total ?? cost, resetAt };
  }

  private memIncrement(
    key: string,
    cost: number,
    windowMs: number,
  ): { total: number; resetAt: number } {
    const now = Date.now();
    let entry = this.memStore.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { total: 0, resetAt: now + windowMs };
    }

    entry.total += cost;
    this.memStore.set(key, entry);
    this.maybeCleanMemStore(now);

    return { total: entry.total, resetAt: entry.resetAt };
  }

  private async getCurrentState(
    key: string,
    windowMs: number,
  ): Promise<{ total: number; resetAt: number }> {
    if (this.redis) {
      try {
        const pipeline = this.redis.pipeline();
        pipeline.get(key);
        pipeline.pttl(key);
        const [[, raw], [, pttl]] = (await pipeline.exec()) as [
          [null, string | null],
          [null, number],
        ];
        const total = raw ? parseInt(raw, 10) : 0;
        const resetAt = pttl > 0 ? Date.now() + pttl : Date.now() + windowMs;
        return { total, resetAt };
      } catch {
        // fallthrough to memory
      }
    }

    const entry = this.memStore.get(key);
    const now = Date.now();
    if (!entry || entry.resetAt <= now) {
      return { total: 0, resetAt: now + windowMs };
    }
    return entry;
  }

  private maybeCleanMemStore(now: number): void {
    if (this.memStore.size < 500 && now - this.lastMemCleanup < 60_000) return;
    for (const [i, v] of this.memStore.entries()) {
      if (v.resetAt <= now) this.memStore.delete(k);
    }
    this.lastMemCleanup = now;
  }
}
