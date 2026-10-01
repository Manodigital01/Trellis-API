import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { ExpensiveOpsRateLimiterService } from './expensive-ops-rate-limiter.service';
import { RATE_LIMIT_HEADERS } from './expensive-ops.rules';

export const EXPENSIVE_OP_KEY = 'trellis:expensive_op';

/** Decorator — mark a route as an expensive operation subject to per-user quota. */
export const ExpensiveOperation = (operationKey: string) =>
  applyDecorators(
    SetMetadata(EXPENSIVE_OP_KEY, operationKey),
    UseGuards(ExpensiveOpsGuard),
  );

@Injectable()
export class ExpensiveOpsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: ExpensiveOpsRateLimiterService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const operationKey = this.reflector.getAllAndOverride<string>(EXPENSIVE_OP_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    if (!operationKey) return true;

    const req = ctx.switchToHttp().getRequest();
    const res: Response = ctx.switchToHttp().getResponse();
    const userId: string = req.user?.id ?? req.ip ?? 'anonymous';
    const roles: string[] = req.user?.roles ?? [];

    const decision = this.limiter.check(operationKey, userId, roles);

    // Always set rate-limit headers so clients know their quota
    res.setHeader(RATE_LIMIT_HEADERS.LIMIT,     String(decision.limit));
    res.setHeader(RATE_LIMIT_HEADERS.REMAINING,  String(decision.remaining));
    res.setHeader(RATE_LIMIT_HEADERS.RESET,      new Date(decision.resetAt).toISOString());
    res.setHeader(RATE_LIMIT_HEADERS.SCOPE,      decision.scope);

    if (!decision.allowed) {
      if (decision.retryAfterMs) {
        res.setHeader(RATE_LIMIT_HEADERS.RETRY_AFTER, String(Math.ceil(decision.retryAfterMs / 1000)));
      }
      throw new ForbiddenException({
        errorCode: 'RATE_LIMITED',
        message: `Rate limit exceeded for operation "${operationKey}". ${
          decision.retryAfterMs
            ? `Retry after ${Math.ceil(decision.retryAfterMs / 1000)}s.`
            : ''
        }`,
        limit: decision.limit,
        remaining: 0,
        resetAt: new Date(decision.resetAt).toISOString(),
        retryAfterMs: decision.retryAfterMs,
        scope: decision.scope,
      });
    }

    return true;
  }
}
