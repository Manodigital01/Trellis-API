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

@Injectable()
export class QuotaEnforcementGuard implements CanActivate {
  private readonly logger = new Logger(QuotaEnforcementGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly budget: QuotaBudgetService,
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

  private resolveActor(request: any): string {
    const user = request.user;
    if (user?.id) return `user:${user.id}`;
    if (user?.sub) return `user:${user.sub}`;
    if (user?.address) return `wallet:${String(user.address).toLowerCase()}`;
    const xff = request.headers?.["x-forwarded-for"];
    if (typeof xff === "string") return `ip:${xff.split(",")[0].trim()}`;
    return `ip:${request.ip ?? "unknown"}`;
  }

  private setHeaders(
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
}
