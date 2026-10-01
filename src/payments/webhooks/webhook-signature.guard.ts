import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  RawBodyRequest,
} from "@nestjs/common";
import { Request } from "express";
import { WebhookSignatureService } from "./webhook-signature.service";
import { WebhookProvider } from "./webhook-signature.types";

export interface VerifiedWebhookContext {
  provider: WebhookProvider;
  timestampSeconds: number | null;
}

/**
 * Rejects a webhook delivery unless its signature proves possession of the
 * provider's shared secret.
 *
 * Runs before validation, interceptors, and the handler, so an unsigned or
 * mis-signed request never reaches payment logic. A missing raw body is itself
 * a rejection: verification must never fall back to the parsed object.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(private readonly signatures: WebhookSignatureService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request> & { verifiedWebhook?: unknown }>();

    const verification = this.signatures.verify({
      provider: String(request.params?.provider ?? ""),
      headers: request.headers,
      rawBody: request.rawBody,
      now: Date.now(),
    });

    // `=== false`, not `!verification.ok`: this project compiles with
    // `strictNullChecks: false`, under which a falsy check does not narrow a
    // discriminated union.
    if (verification.ok === false) {
      this.logger.warn(
        `Webhook rejected (${verification.reason}): ${verification.message}`,
      );

      throw new HttpException(
        {
          statusCode: verification.status,
          error:
            verification.status === 503
              ? "Service Unavailable"
              : "Bad Request",
          reason: verification.reason,
          message: verification.message,
        },
        verification.status,
      );
    }

    request.verifiedWebhook = {
      provider: verification.provider,
      timestampSeconds: verification.timestampSeconds,
    } satisfies VerifiedWebhookContext;

    return true;
  }
}
