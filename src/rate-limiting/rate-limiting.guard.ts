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
} from "../common/decorators/rate-limit.decorator";
import {
  RateLimitTier,
  getRateLimitPolicyFromEnv,
  normalizeRateLimitTier,
  resolveRateLimitTierFromRole,
} from "../config/quota.config";
import { RateLimitStrategy } from "./interfaces";
import { RateLimiterService } from "./rate-limiter.service";
import {
  rateLimitAllowedTotal,
  rateLimitDeniedTotal,
} from "./rate-limiting.metrics";

interface ResolvedPolicy {
  tier: RateLimitTier;
  label: string;
  limit: number;
  windowMs: number;
  burst: number;
  strategy: RateLimitStrategy;
}

@Injectable()
export class DistributedRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(DistributedRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const clientIp = this.getClientIp(request);
    const userId = this.getUserId(request);
    const path = this.getScope(request, options);

    // 1. Blacklist Check
    const isBlacklisted = await this.rateLimiter.isBlacklisted(
      clientIp,
      userId ? String(userId) : undefined,
    );

    if (isBlacklisted) {
      await this.rateLimiter.recordViolation({
        ip: clientIp,
        tracker: userId ? `user:${userId}` : `ip:${clientIp}`,
        userId: userId ? String(userId) : undefined,
        route: path,
        method: request.method || "GET",
        tier: "blacklisted",
        strategy: RateLimitStrategy.TokenBucket,
        limit: 0,
        reason: "blacklisted",
      });

      if (typeof response?.header === "function") {
        response.header("X-RateLimit-Blocked", "blacklisted");
      } else if (typeof response?.setHeader === "function") {
        response.setHeader("X-RateLimit-Blocked", "blacklisted");
      }

      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          message: "Access forbidden: Client identifier is blacklisted",
          error: "Forbidden",
        },
        HttpStatus.FORBIDDEN,
      );
    }

    // 2. Whitelist Check
    const isWhitelisted = await this.rateLimiter.isWhitelisted(
      clientIp,
      userId ? String(userId) : undefined,
      undefined,
      path,
    );

    if (isWhitelisted) {
      if (typeof response?.header === "function") {
        response.header("X-RateLimit-Whitelisted", "true");
      } else if (typeof response?.setHeader === "function") {
        response.setHeader("X-RateLimit-Whitelisted", "true");
      }
      return true;
    }

    // 3. Resolve Policy
    const tier = this.resolveRequestTier(request);
    const policy = this.resolvePolicy(options, tier);

    // 4. Dual-layer limits: an unauthenticated IP may not exhaust the
    //    quota of an authenticated user sharing its traffic, so each
    //    request is checked against BOTH the IP bucket and — for
    //    authenticated callers — the per-user bucket. The most restrictive
    //    surviving decision wins.
    const scope = this.getScope(request, options);
    const ipTracker = `ip:${clientIp}`;
    const userTracker = userId !== undefined ? this.getTrackerKey(request) : null;

    const ipDecision = await this.rateLimiter.consume(
      this.buildRateLimitKey(ipTracker, scope, policy.tier),
      {
        limit: policy.limit,
        windowMs: policy.windowMs,
        burst: policy.burst,
        strategy: policy.strategy,
      },
      ipTracker,
      scope,
      policy.tier,
    );

    let decision = ipDecision;
    if (userTracker) {
      const userDecision = await this.rateLimiter.consume(
        this.buildRateLimitKey(userTracker, scope, policy.tier),
        {
          limit: policy.limit,
          windowMs: policy.windowMs,
          burst: policy.burst,
          strategy: policy.strategy,
        },
        userTracker,
        scope,
        policy.tier,
      );
      // Prefer the tighter bucket: a denial on either layer blocks.
      decision =
        !userDecision.allowed
          ? userDecision
          : !ipDecision.allowed
            ? ipDecision
            : {
                ...userDecision,
                remaining: Math.min(ipDecision.remaining, userDecision.remaining),
                resetAt: Math.max(ipDecision.resetAt, userDecision.resetAt),
              };
    }

    this.applyHeaders(response, policy, decision);
    this.recordMetrics(tier, scope, policy.strategy, decision);

    if (!decision.allowed) {
      await this.rateLimiter.recordViolation({
        ip: clientIp,
        tracker: userTracker ?? ipTracker,
        userId: userId ? String(userId) : undefined,
        route: path,
        method: request.method || "GET",
        tier: policy.tier,
        strategy: policy.strategy,
        limit: policy.limit,
        reason: "rate_limit_exceeded",
      });

      const retryAfter = decision.retryAfterMs
        ? Math.ceil(decision.retryAfterMs / 1000)
        : Math.ceil((decision.resetAt - Date.now()) / 1000);

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: "Rate limit exceeded",
          limit: policy.limit,
          remaining: 0,
          resetAt: new Date(decision.resetAt).toISOString(),
          retryAfter: retryAfter,
          tier: policy.tier,
          strategy: policy.strategy,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (decision.remaining <= Math.max(1, Math.ceil(policy.limit * 0.1))) {
      this.logger.warn(
        `Approaching rate limit for ${userTracker ?? ipTracker} (${policy.label}): ` +
          `${policy.limit - decision.remaining}/${policy.limit}`,
      );
    }

    return true;
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
        limit: envPolicy.limit,
        windowMs: envPolicy.windowMs,
        burst: envPolicy.burst,
        strategy: this.resolveStrategy(options?.strategy),
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
      strategy: this.resolveStrategy(options.strategy),
    };
  }

  private resolveStrategy(strategy?: RateLimitStrategy): RateLimitStrategy {
    if (strategy) return strategy;

    const envStrategy = String(
      process.env.RATE_LIMIT_DEFAULT_STRATEGY ?? "token-bucket",
    ).toLowerCase();

    if (envStrategy === "sliding-window") {
      return RateLimitStrategy.SlidingWindow;
    }

    return RateLimitStrategy.TokenBucket;
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

  private getClientIp(request: any): string {
    const xff = request.headers?.["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      return xff.split(",")[0].trim();
    }
    return request.ip ?? "127.0.0.1";
  }

  private getUserId(request: any): string | number | undefined {
    return request.user?.id ?? request.user?.sub ?? request.user?.address;
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
    request: {
      route?: { path?: string };
      originalUrl?: string;
      url?: string;
    },
    options: RateLimitOptions | undefined,
  ): string {
    if (options?.key) {
      return options.key;
    }

    if (!options) {
      return "global";
    }

    return request.route?.path || request.originalUrl || request.url || "route";
  }

  private buildRateLimitKey(
    tracker: string,
    scope: string,
    tier: string,
  ): string {
    return `${tracker}:${scope}:${tier}`;
  }

  private applyHeaders(
    response: any,
    policy: ResolvedPolicy,
    decision: {
      allowed: boolean;
      remaining: number;
      resetAt: number;
      retryAfterMs?: number;
    },
  ): void {
    const headers: Array<[string, string | number]> = [
      // RFC 9331 RateLimit header fields, plus the de-facto X-RateLimit-
      // equivalents used by existing clients.
      ["RateLimit-Limit", policy.limit],
      ["RateLimit-Remaining", decision.remaining],
      ["RateLimit-Reset", Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000))],
      ["X-RateLimit-Limit", policy.limit],
      ["X-RateLimit-Remaining", decision.remaining],
      ["X-RateLimit-Reset", new Date(decision.resetAt).toISOString()],
      ["X-RateLimit-Tier", policy.tier],
      ["X-RateLimit-Strategy", policy.strategy],
    ];

    if (!decision.allowed && decision.retryAfterMs) {
      const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
      headers.push(["Retry-After", retryAfterSeconds]);
    }

    for (const [name, value] of headers) {
      if (typeof response?.header === "function") {
        response.header(name, value);
      } else if (typeof response?.setHeader === "function") {
        response.setHeader(name, value);
      }
    }
  }

  private recordMetrics(
    tier: RateLimitTier,
    scope: string,
    strategy: RateLimitStrategy,
    decision: { allowed: boolean; remaining: number },
  ): void {
    const label = { tier, scope, strategy, key: scope };

    if (decision.allowed) {
      rateLimitAllowedTotal.inc(label);
    } else {
      rateLimitDeniedTotal.inc(label);
    }
  }
}
