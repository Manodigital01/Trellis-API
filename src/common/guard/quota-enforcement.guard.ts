/**
 * QuotaEnforcementGuard — enforces per-user budget quotas on expensive operations.
 *
 * Applied per-route via @EnforceQuota().  Reads the actor identity from the
 * authenticated request (userId → walletAddress → IP, in that order).
 *
 * Hard mode (default): returns 429 with a remediation message when quota is exceeded.
 * Soft mode (@EnforceQuota({ ..., soft: true })): logs a warning and allows the request.
 *
 * Issue: #65
 */

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
  QUOTA_ENFORCE_KEY,
  QuotaEnforceOptions,
} from "../decorators/quota.decorator";
import { QuotaBudgetService } from "../quota/quota-budget.service";

export const TIER_MONTHLY_LIMITS = {
  free: 10_000,
  pro: 1_000_000,
  enterprise: Number.POSITIVE_INFINITY,
} as const;

export type QuotaTier = keyof typeof TIER_MONTHLY_LIMITS;

export interface QuotaCounter {
  increment(key: string, ttlSeconds: number): Promise<number>;
}

export const QUOTA_COUNTER_TOKEN = Symbol.for("QUOTA_COUNTER");

@Injectable()
export class QuotaEnforcementGuard implements CanActivate {
  private readonly logger = new Logger(QuotaEnforcementGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly budget: QuotaBudgetService,
    @Optional()
    private readonly counter?: QuotaCounter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<QuotaEnforceOptions>(
      QUOTA_ENFORCE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No quota annotation on this route → allow
    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    const actor = this.resolveActor(request);
    const cost = options.cost ?? 1;

    const result = await this.budget.consume(options.resource, actor, cost);

    // Always set informational headers
    const response = context.switchToHttp().getResponse();
    this.setHeaders(response, result.limit, result.remaining, result.resetAt);

    if (!result.allowed) {
      if (options.soft) {
        this.logger.warn(
          `[soft-quota] Actor ${actor} exceeded ${options.resource} quota ` +
            `(${result.total}/${result.limit}). Allowing request per soft-limit policy.`,
        );
        return true;
      }

      this.logger.warn(
        `[quota] Actor ${actor} blocked: ${options.resource} quota exhausted ` +
          `(${result.total}/${result.limit})`,
      );

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: "Quota Exceeded",
          code: "QUOTA_EXCEEDED",
          message: result.message,
          resource: options.resource,
          limit: result.limit,
          used: result.total,
          remaining: 0,
          resetAt: result.resetAt.toISOString(),
          remediation:
            "Wait for your quota window to reset, or contact your administrator to request a limit increase.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Monthly tier-based quota enforcement.
   *
   * Increments the Redis key `quota:{apiKey}:{YYYY-MM}` for the current month,
   * compares the count against the tenant plan tier limit, attaches
   * `X-Quota-Limit` / `X-Quota-Remaining` to the response, and returns 429
   * with `QUOTA_EXCEEDED` when the monthly quota is exhausted.
   */
  async enforceMonthlyQuota(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const apiKey = this.resolveApiKey(request);
    const tier = this.resolveTier(request);
    const limit = TIER_MONTHLY_LIMITS[tier];

    // Enterprise is unlimited — still attach informational headers.
    if (!isFinite(limit)) {
      this.setQuotaHYXRs(response, -1, -1, this.nextMonthReset());
      return true;
    }

    const now = new Date();
    const resetAt = this.nextMonthReset(now);
    const key = `quota:${apiKey}:${this.monthKey(now)}`;

    if (!this.counter) {
      // No Redis backend configured — fail open but still expose headers.
      this.setQuotaHYXRs(response, limit, limit, resetAt);
      return true;
    }

    const ttlSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
    const used = await this.counter.increment(key, ttlSeconds);
    const remaining = Math.max(0, limit - used);

    this.setQuotaHYXRs(response, limit, remaining, resetAt);

    if (used > limit) {
      this.logger.warn(
        `[quota] API key ${apiKey} (${tier}) exhausted monthly quota ` +
          `${used}/${limit} for ${this.monthKey(now)}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: "Quota Exceeded",
          code: "QUOTA_EXCEEDED",
          message: `Monthly API call quota exceeded for ${tier} tier.`,
          tier,
          limit,
          used,
          remaining: 0,
          resetAt: resetAt.toISOString(),
          remediation:
            "Upgrade your subscription plan or wait for the monthly quota to reset.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private resolveActor(request: any): string {
    const user = request.user;
    if (user?.id) return `user:${user.id}`;
    if (user?.sub) return `user:${user.sub}`;
    if (user?.address) return `wallet:${String(user.address).toLowerCase()}`;
    const xff = request.headers?.["x-forwarded-for"];
    if (typeof xff === "string") return `ip:${xff.split(",")[0].trim()}`;
    return `ip:${request.ip ?? "unknown"}`;
  }

  private resolveApiKey(request: any): string {
    const headers = request.headers ?? {};
    const raw =
      headers["x-api-key"] ??
      headers["api-xey"] ??
      request.apiKey ??
      request.user?.apiKey ??
      request.user?.sub ??
      request.user?.id;
    if (typeof raw === "string" && raw.length > 0) return raw;
    return this.resolveActor(request);
  }

  private resolveTier(request: any): QuotaTier {
    const candidate =
      request.user?.plan?.tier ??
      request.user?.tier ??
      request.tenant?.tier ??
      request.headers?.["x-plan-tier"] ??
      request.headers?.["x-tier"];
    const normalized = typeof candidate === "string" ? candidate.toLowerCase() : "";
    if (normalized in TIER_MONTHLY_LIMITS) {
      return normalized as QuotaTier;
    }
    return "free";
  }

  private monthKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  private nextMonthReset(from: Date = new Date()): Date {
    return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }

  private setQuotaHeaders(
    response: any,
    limit: number,
    remaining: number,
    resetAt: Date,
  ): void {
    const safeLimit = isFinite(limit) ? limit : -1;
    const safeRemaining = isFinite(remaining) ? remaining : -1;
    const pairs: [string, string | number][] = [
      ["X-Quota-Limit", safeLimit],
      ["X-Quota-Remaining", safeRemaining],
      ["X-Quota-Reset", resetAt.toISOString()],
    ];
    for (const [name, value] of pairs) {
      try {
        if (typeof response?.setHeader === "function") {
          response.setHeader(name, value);
        } else if (typeof response?.header === "function") {
          response.header(name, value);
        }
      } catch {
        // header setting is best-effort
      }
    }
  }

  private setHeaders(
    response: any,
    limit: number,
    remaining: number,
    resetAt: Date,
  ): void {
    this.setQuotaHeaders(response, limit, remaining, resetAt);
  }
}
