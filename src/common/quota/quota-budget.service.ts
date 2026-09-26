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
  | "search:query"    // Elasticsearch heavy query
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
    windowMs: 3_600_000,
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
    windowMs: 3_600_000,
    description: "File upload quota (per MB = 1 unit)",
  },
  {
    resource: "compute:job",
    limit: 100,
    windowMs: 3_600_000,
    description: "Background compute job submissions per hour",
  },
  {
    resource: "search:query",
    limit: 1000,
    windowMs: 3_600_000,
    description: "Elasticsearch query quota per hour",
  },
  {
    resource: "portfolio:backtest",
    limit: 20,
    windowMs: 3_600_000,
    description: "Portfolio backtest runs per hour",
  },
];

const REDIS_KEY_PREFIX = "trellis:quota:";

@Injectable()
export class QuotaBudgetService {
  private readonly logger = new Logger(QuotaBudgetService.name);
  private readonly policies = new Map<ResourceKey, QuotaPolicy>();
  /** In-memory fallback when Redis is unavailable */
  private readonly memStore = new Map<string, { total: number; resetAt: number }>();
  private lastMemCleanup = Date.now();

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(QUOTA_BUDGET_REDIS) private readonly redis: Redis | null,
  ) {
    for (const policy of DEFAULT_QUOTA_POLICIES) {
      this.policies.set(policy.resource, policy);
    }
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
      .filter(([k, v]) => k.endsWith(`:${resource}`) && v.resetAt > now)
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
    for (const [k, v] of this.memStore.entries()) {
      if (v.resetAt <= now) this.memStore.delete(k);
    }
    this.lastMemCleanup = now;
  }
}
