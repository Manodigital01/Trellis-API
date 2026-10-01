import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import {
  WEBHOOK_PROVIDERS,
  WebhookSignatureFailureReason,
  WebhookVerification,
  WebhookVerificationFailure,
  WebhookVerificationInput,
} from "./webhook-signature.types";
import {
  WebhookSignatureScheme,
  extractTimestamp,
  resolveScheme,
} from "./webhook-signature.scheme";

/** Replay window when `PAYMENTS_WEBHOOK_TOLERANCE_SECONDS` is unset. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Outcome of the timestamp/replay-window check. */
type TimestampResolution =
  | { ok: true; timestamp: number | null }
  | WebhookVerificationFailure;

/**
 * Verifies incoming payment webhook signatures against the untouched request
 * body.
 *
 * The digest is computed over the raw bytes exactly as they arrived, never over
 * a re-serialised object: `JSON.stringify(JSON.parse(body))` is not byte-stable
 * (key order, whitespace, unicode escaping), so re-encoding would reject every
 * legitimate call the moment a provider changes its serializer.
 */
@Injectable()
export class WebhookSignatureService {
  private readonly logger = new Logger(WebhookSignatureService.name);

  constructor(private readonly config: ConfigService) {}

  /** Max accepted clock skew, in seconds. */
  get toleranceSeconds(): number {
    const configured = Number(
      this.config.get<string | number>(
        "PAYMENTS_WEBHOOK_TOLERANCE_SECONDS",
        DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
      ),
    );

    return Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  }

  verify(input: WebhookVerificationInput): WebhookVerification {
    const scheme = resolveScheme(input.provider);

    if (!scheme) {
      return this.fail(
        "unknown_provider",
        400,
        `Unsupported webhook provider "${input.provider}". Expected one of: ${WEBHOOK_PROVIDERS.join(", ")}.`,
      );
    }

    const secret = this.resolveSecret(scheme);

    if (!secret) {
      this.logger.error(
        `No webhook secret configured for provider "${scheme.provider}" (looked at ${scheme.secretEnvVars.join(", ")}); refusing the delivery.`,
      );

      return this.fail(
        "secret_not_configured",
        503,
        `Webhook verification for "${scheme.provider}" is not configured on this server.`,
      );
    }

    const rawBody = this.readRawBody(input);

    if (rawBody === null) {
      return this.fail(
        "raw_body_unavailable",
        400,
        "Raw request body is unavailable, so the signature cannot be verified.",
      );
    }

    const signatureHeader = this.pickHeader(
      input.headers,
      scheme.signatureHeaders,
    );

    if (signatureHeader === null) {
      return this.fail(
        "missing_signature",
        400,
        `Missing signature header. Expected one of: ${scheme.signatureHeaders.join(", ")}.`,
      );
    }

    const resolvedTimestamp = this.resolveTimestamp(
      scheme,
      input.headers,
      input.now,
    );

    // `=== false` (not a falsy check): the project compiles with
    // `strictNullChecks: false`, where a falsy check does not narrow the union.
    if (resolvedTimestamp.ok === false) {
      return resolvedTimestamp;
    }

    const timestamp = resolvedTimestamp.timestamp;

    const candidates = scheme.extractSignatures(signatureHeader);

    if (candidates.length === 0) {
      return this.fail(
        "malformed_signature",
        400,
        `No usable signature found in the ${scheme.signatureHeaders[0]} header.`,
      );
    }

    const payload = scheme.signedPayload(rawBody, timestamp);

    for (const encoding of scheme.encodings) {
      const expected = createHmac("sha256", secret)
        .update(payload, "utf8")
        .digest(encoding);

      if (
        candidates.some((candidate) => constantTimeEquals(candidate, expected))
      ) {
        return {
          ok: true,
          provider: scheme.provider,
          timestampSeconds: timestamp,
        };
      }
    }

    this.logger.warn(
      `Rejected webhook for provider "${scheme.provider}": signature mismatch.`,
    );

    return this.fail("invalid_signature", 400, "Invalid webhook signature.");
  }

  /**
   * Enforces the replay window. Returns the signed timestamp (`null` when the
   * scheme has none) or the failure to answer with.
   */
  private resolveTimestamp(
    scheme: WebhookSignatureScheme,
    headers: Record<string, string | string[] | undefined>,
    now: number | undefined,
  ): TimestampResolution {
    const headerValue = this.pickHeader(headers, scheme.timestampHeaders);

    if (headerValue === null) {
      return scheme.requiresTimestamp
        ? this.fail(
            "missing_timestamp",
            400,
            `Missing timestamp header. Expected one of: ${scheme.timestampHeaders.join(", ")}.`,
          )
        : { ok: true, timestamp: null };
    }

    const timestamp = extractTimestamp(headerValue);

    if (timestamp === "malformed") {
      return this.fail(
        "malformed_timestamp",
        400,
        "Webhook timestamp header is not a unix timestamp.",
      );
    }

    if (timestamp === "missing" || timestamp === null) {
      return scheme.requiresTimestamp
        ? this.fail(
            "missing_timestamp",
            400,
            "Webhook timestamp is required for signature verification.",
          )
        : { ok: true, timestamp: null };
    }

    // A timestamp far in the future is as suspicious as a stale one.
    const drift = Math.abs(Math.floor((now ?? Date.now()) / 1000) - timestamp);

    if (drift > this.toleranceSeconds) {
      return this.fail(
        "stale_timestamp",
        400,
        `Webhook timestamp is outside the ${this.toleranceSeconds}s replay window.`,
      );
    }

    return { ok: true, timestamp };
  }

  private resolveSecret(scheme: WebhookSignatureScheme): string | null {
    for (const envVar of scheme.secretEnvVars) {
      const value = this.config.get<string>(envVar);

      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }

  private readRawBody(input: WebhookVerificationInput): string | null {
    const { rawBody } = input;

    if (Buffer.isBuffer(rawBody)) {
      return rawBody.length > 0 ? rawBody.toString("utf8") : null;
    }

    if (typeof rawBody === "string") {
      return rawBody.length > 0 ? rawBody : null;
    }

    return null;
  }

  private pickHeader(
    headers: Record<string, string | string[] | undefined>,
    names: readonly string[],
  ): string | null {
    for (const name of names) {
      const value = headers[name.toLowerCase()] ?? headers[name];

      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }

      if (Array.isArray(value)) {
        const first = value.find(
          (entry) => typeof entry === "string" && entry.trim().length > 0,
        );

        if (first) {
          return first;
        }
      }
    }

    return null;
  }

  private fail(
    reason: WebhookSignatureFailureReason,
    status: 400 | 503,
    message: string,
  ): WebhookVerificationFailure {
    return { ok: false, reason, status, message };
  }
}

/** Length-checked constant-time comparison of two digest strings. */
function constantTimeEquals(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
