import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { RawBodyRequest } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";

/**
 * Makes the untouched request body available as `req.rawBody` on the payment
 * webhook route.
 *
 * Nest populates `rawBody` while parsing (see `rawBody: true` in `main.ts`),
 * and this middleware is the single place that guarantees its shape before a
 * signature is ever checked:
 *
 * - normalises whatever the adapter attached (`Buffer`, string, or a raw
 *   `req.body` left by `express.raw()`) into a `Buffer`;
 * - answers `400` and stops the request when no raw body exists, instead of
 *   letting a verifier run against a re-serialised object — a webhook whose
 *   exact bytes are gone can never be verified, and failing open here would
 *   turn a transport hiccup into an unauthenticated payment event.
 */
@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RawBodyMiddleware.name);

  use(
    request: RawBodyRequest<Request>,
    response: Response,
    next: NextFunction,
  ): void {
    const rawBody = resolveRawBody(request);

    if (rawBody === null) {
      this.logger.warn(
        `Rejected webhook delivery to ${request.originalUrl}: raw request body is unavailable.`,
      );

      response.status(400).json({
        statusCode: 400,
        error: "Bad Request",
        reason: "raw_body_unavailable",
        message:
          "Raw request body is unavailable, so the signature cannot be verified.",
      });
      return;
    }

    request.rawBody = rawBody;
    next();
  }
}

function resolveRawBody(request: RawBodyRequest<Request>): Buffer | null {
  // Widened to `unknown` on purpose: `RawBodyRequest.rawBody` is typed as
  // `Buffer`, but Nest's express adapter has shipped versions that assign a
  // string here, so both shapes are inspected at runtime.
  const rawBody: unknown = request.rawBody;

  if (Buffer.isBuffer(rawBody)) {
    return rawBody.length > 0 ? rawBody : null;
  }

  if (typeof rawBody === "string") {
    return rawBody.length > 0 ? Buffer.from(rawBody, "utf8") : null;
  }

  // A route-scoped raw parser (`express.raw()`) leaves the Buffer on `body`.
  const body: unknown = request.body;

  return Buffer.isBuffer(body) && body.length > 0 ? body : null;
}
