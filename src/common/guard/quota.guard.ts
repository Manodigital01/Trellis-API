import { createClient, RedisClientType } from "redis";
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
} from "../decorators/rate-limit.decorator";
import {
  RateLimitTier,
  getRateLimitPolicyFromEnv,
  normalizeRateLimitTier,
  resolveRateLimitTierFromRole,
} from "src/config/quota.config";

const MONTHLY_QUOTA_LIMITS: Record<RateLimitTier, number> = {
  free: 10_000,
  pro: 1_000_000,
  enterprise: Number.POSITIVE_INFINITY,
};

const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED";

function currentMonthKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

interface RateWindowState {
  count: number;
  resetAt: number;
}

interface ResolvedPolicy {
  tier: RateLimitTier;
  label: string;
  limit: number;
  windowMs: number;
  burst: number;
}

@Injectable()
export class QuotaGuard implements CanActivate {
  private readonly logger = new Logger(QuotaGuard.name);
  private readonly windows = new Map<string, RateWindowState>();
  private lastCleanupAt = Date.now();
  private redisClient: RedisClientType | null = null;
  private redisReady: Promise<RedisClientType | null> | null = null;

  constructor(private readonly reflector: Reflector) {
    void this.getRedisClient();
  }

  private async getRedisClient(): Promise<RedisClientType | null> {
    if (this.redisClient?.isOpen) {
      return this.redisClient;
    }

    if (!this.redisReady) {
      const url = process.env.REDIS_URL;
      if (!url) {
        this.redisReady = Promise.resolve(null);
      } else {
        const client = createClient({ url }) as RedisClientType;
        client.on("error", (err) =>
          this.logger.error(`Redis quota client error: ${String(err)}`),
        );
        this.redisReady = client
          .connect()
          .then(() => {
            this.redisClient = client;
            return client;
          })
          .catch((err) => {
            this.logger.error(`Failed to connect Redis quota client: ${String(err)}`);
            return null;
          });
      }
    }

    return this.redisReady;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const tier = this.resolveRequestTier(request);
    const policy = this.resolvePolicy(options, tier);
    const tracker = this.getTrackerKey(request);
    const scope = this.getScope(request, options);
    const key = `${tracker}:${scope}:${policy.tier}`;
    const apiKey = this.getApiKey(request);

    const decision = this.consume(key, policy.limit, policy.windowMs);
    this.applyHeaders(response, policy, decision.remaining, decision.resetAt);

    if (!decision.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: "Rate limit exceeded",
          limit: policy.limit,
          remaining: 0,
          resetAt: new Date(decision.resetAt).toISOString(),
          tier: policy.tier,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (apiKey) {
      const quota = await this.consumeMonthlyQuota(apiKey, policy.tier);
      this.applyQuotaHeaders(response, quota);

      if (!quota.allowed) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: QUOTA_EXCEEDED_CODE,
            message: "Monthly API quota exceeded",
            limit: quota.limit,
            remaining: 0,
            resetAt: quota.resetAt.toISOString(),
            tier: policy.tier,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (
        Number.isFinite(quota.limit) &&
        quota.remaining <= Math.max(1, Math.ceil(quota.limit * 0.1))
      ) {
        this.logger.warn(
          `Approaching monthly quota for ${apiKey} (${policy.tier}): ` +
            `${quota.limit - quota.remaining}/${quota.limit}`,
        );
      }
    }

    if (decision.remaining <= Math.max(1, Math.ceil(policy.limit * 0.1))) {
      this.logger.warn(
        `Approaching rate limit for ${tracker} (${policy.label}): ` +
          `${policy.limit - decision.remaining}/${policy.limit}`,
      );
    }

    return true;
  }

  private getApiKey(request: {
    apiKey?: string;
    headers?: Record<string, unknown>;
    user?: { apiKey?: string };
  }): string | null {
    const headerKey = request.headers?.["x-api-key"];
    const candidate =
      request.apiKey ??
      request.user?.apiKey ??
      (typeof headerKey === "string" ? headerKey : undefined);

    if (!candidate || typeof candidate !== "string") {
      return null;
    }

    return candidate;
  }

  private async consumeMonthlyQuota(
    apiKey: string,
    tier: RateLimitTier,
  ): Promise<{
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: Date;
  }> {
    const limit = MONTHLY_QUOTA_LIMITS[tier] ?? MONTHLY_QUOTA_LIMITS.free;
    const monthKey = currentMonthKey();
    const resetAt = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth() + 1,
        1,
        0,
        0,
        0,
        0,
      ),
    );

    if (!Number.isFinite(limit)) {
      return { allowed: true, limit, remaining: Number.POSITIVE_INFINITY, resetAt };
    }

    const redis = await this.getRedisClient();
    if (!redis) {
      return { allowed: true, limit, remaining: limit, resetAt };
    }

    const redisKey = `quota:${apiKey}:${monthKey}`;
    const count = await redis.incr(redisKey);

    if (count === 1) {
      const ttlSeconds = Math.max(
        1,
        Math.ceil((resetAt.getTime() - Date.now()) / 1000),
      );
      await redis.expire(redisKey, ttlSeconds);
    }

    const remaining = Math.max(0, limit - count);
    return {
      allowed: count <= limit,
      limit,
      remaining,
      resetAt,
    };
  }

  private applyQuotaHeaders(
    response: any,
    quota: { limit: number; remaining: number; resetAt: Date },
  ): void {
    const headers: Array<[string, string | number]> = [
      ["X-Quota-Limit", quota.limit],
      [
        "X-Quota-Remaining",
        Number.isFinite(quota.remaining) ? quota.remaining : "unlimited",
      ],
      ["X-Quota-Reset", quota.resetAt.toISOString()],
    ];

    for (const [name, value] of headers) {
      if (typeof response?.header === "function") {
        response.header(name, value);
      } else if (typeof response?.setHeader === "function") {
        response.setHeader(name, value);
      }
    }
  }

  private resolvePolicy(
    options: RateLimitOptions | undefined,
    tier: RateLimitTier,
  ): ResolvedPolicy {
    const envPolicy = getRateLimitPolicyFromEnv(
      tier,
      process.env as Record<string, unknown>,
    );

    if (!options) {
      return {
        tier,
        label: tier,
        ...envPolicy,
      };
    }

    const configuredTier = options.level
      ? normalizeRateLimitTier(options.level)
      : tier;
    const levelPolicy = getRateLimitPolicyFromEnv(
      configuredTier,
      process.env as Record<string, unknown>,
    );

    return {
      tier: configuredTier,
      label: options.level || configuredTier,
      limit: options.limit ?? levelPolicy.limit,
      windowMs: options.windowMs ?? levelPolicy.windowMs,
      burst: options.burst ?? levelPolicy.burst,
    };
  }

  private resolveRequestTier(request: {
    authType?: string;
    user?: {
      id?: string | number;
      role?: string;
      tier?: string;
      type?: string;
    };
  }): RateLimitTier {
    const explicitTier = request.user?.tier;
    const authType = request.authType ?? request.user?.type;

    if (authType === "api-key") {
      return normalizeRateLimitTier(explicitTier ?? "enterprise");
    }

    return resolveRateLimitTierFromRole(
      request.user?.role,
      authType,
      explicitTier,
    );
  }

  private getTrackerKey(request: {
    ip?: string;
    headers?: Record<string, unknown>;
    user?: { id?: string | number; sub?: string | number; address?: string };
  }): string {
    const userId = request.user?.id ?? request.user?.sub;
    if (userId !== undefined && userId !== null) {
      return `user:${String(userId)}`;
    }

    if (request.user?.address) {
      return `wallet:${request.user.address.toLowerCase()}`;
    }

    const xff = request.headers?.["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      return `ip:${xff.split(",")[0].trim()}`;
    }

    return `ip:${request.ip ?? "unknown"}`;
  }

  private getScope(
    request: { route?: { path?: string }; originalUrl?: string; url?: string },
    options: RateLimitOptions | undefined,
  ): string {
    if (!options) {
      return "global";
    }

    return request.route?.path || request.originalUrl || request.url || "route";
  }

  private consume(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let state = this.windows.get(key);

    if (!state || state.resetAt <= now) {
      state = {
        count: 0,
        resetAt: now + windowMs,
      };
      this.windows.set(key, state);
    }

    state.count += 1;
    const remaining = Math.max(0, limit - state.count);
    const allowed = state.count <= limit;

    this.windows.set(key, state);
    this.cleanupExpired(now);

    return {
      allowed,
      remaining,
      resetAt: state.resetAt,
    };
  }

  private applyHeaders(
    response: any,
    policy: ResolvedPolicy,
    remaining: number,
    resetAt: number,
  ): void {
    const headers: Array<[string, string | number]> = [
      ["X-RateLimit-Limit", policy.limit],
      ["X-RateLimit-Remaining", remaining],
      ["X-RateLimit-Reset", new Date(resetAt).toISOString()],
      ["X-RateLimit-Tier", policy.tier],
    ];

    for (const [name, value] of headers) {
      if (typeof response?.header === "function") {
        response.header(name, value);
      } else if (typeof response?.setHeader === "function") {
        response.setHeader(name, value);
      }
    }
  }

  private cleanupExpired(now: number): void {
    if (this.windows.size === 0) {
      return;
    }

    if (now - this.lastCleanupAt < 30_000 && this.windows.size < 1000) {
      return;
    }

    for (const [key, state] of this.windows.entries()) {
      if (state.resetAt <= now) {
        this.windows.delete(key);
      }
    }

    this.lastCleanupAt = now;
  }
}
