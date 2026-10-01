import {
  WEBHOOK_PROVIDERS,
  WebhookProvider,
} from "./webhook-signature.types";

/** How the provider encodes the digest it sends. */
export type SignatureEncoding = "hex" | "base64";

export interface WebhookSignatureScheme {
  provider: WebhookProvider;
  /** Env vars holding the shared secret, in priority order. */
  secretEnvVars: readonly string[];
  /** Headers carrying the signature, in priority order. */
  signatureHeaders: readonly string[];
  /** Headers carrying the signed timestamp, in priority order. */
  timestampHeaders: readonly string[];
  /** A timestamp is mandatory for the providers that sign one. */
  requiresTimestamp: boolean;
  /** Candidate signatures inside a single header value. */
  extractSignatures(headerValue: string): string[];
  /** The exact string the provider computed its digest over. */
  signedPayload(rawBody: string, timestampSeconds: number | null): string;
  encodings: readonly SignatureEncoding[];
}

/** Shape both Stripe and our generic scheme use: `t=...,v1=...`. */
function extractTimestampedSignatures(headerValue: string): string[] {
  const signatures: string[] = [];

  for (const part of headerValue.split(",")) {
    const [rawKey, ...rest] = part.trim().split("=");
    const value = rest.join("=").trim();

    if (!value) {
      continue;
    }

    const key = rawKey.trim().toLowerCase();
    // v1 is the current HMAC-SHA256 version; v0 was the retired scheme.
    if (key === "v1" || key === "sha256") {
      signatures.push(value);
    } else if (key === "" || key === "signature") {
      // Bare value form, tolerated for gateways that strip the prefix.
      signatures.push(value);
    }
  }

  return signatures;
}

/** `sha256=<hex>`, `sha256=<base64>` or a bare digest. */
function extractPrefixedSignature(headerValue: string): string[] {
  const value = headerValue.trim();

  if (!value) {
    return [];
  }

  const match = value.match(/^[a-z0-9]+=(.+)$/i);

  return match ? [match[1].trim()] : [value];
}

export const WEBHOOK_SIGNATURE_SCHEMES: Record<
  WebhookProvider,
  WebhookSignatureScheme
> = {
  /**
   * Stripe: `Stripe-Signature: t=<unix>,v1=<hex>`, signed over `t.body`.
   * https://docs.stripe.com/webhooks/signature
   */
  stripe: {
    provider: "stripe",
    secretEnvVars: ["STRIPE_WEBHOOK_SECRET"],
    signatureHeaders: ["stripe-signature"],
    timestampHeaders: ["stripe-signature"],
    requiresTimestamp: true,
    extractSignatures: extractTimestampedSignatures,
    signedPayload: (rawBody, timestampSeconds) =>
      `${timestampSeconds}.${rawBody}`,
    encodings: ["hex"],
  },

  /**
   * Coinbase Commerce: `X-CC-Webhook-Signature` is the hex HMAC-SHA256 of the
   * raw body. The scheme carries no timestamp, so there is no replay window to
   * enforce here; the shared secret plus the provider's event id is the
   * control, and a timestamp is still checked if one is ever sent.
   */
  coinbase: {
    provider: "coinbase",
    secretEnvVars: ["COINBASE_WEBHOOK_SECRET"],
    signatureHeaders: ["x-cc-webhook-signature", "cb-signature"],
    timestampHeaders: ["x-cc-webhook-timestamp"],
    requiresTimestamp: false,
    extractSignatures: extractPrefixedSignature,
    signedPayload: (rawBody) => rawBody,
    encodings: ["hex"],
  },

  /** Anything else: `X-Webhook-Signature` over `<unix>.<body>`. */
  generic: {
    provider: "generic",
    secretEnvVars: ["PAYMENTS_WEBHOOK_SECRET", "WEBHOOK_HMAC_SECRET"],
    signatureHeaders: [
      "x-webhook-signature",
      "x-signature",
      "x-hub-signature-256",
    ],
    timestampHeaders: ["x-webhook-timestamp", "x-timestamp"],
    requiresTimestamp: true,
    extractSignatures: extractPrefixedSignature,
    signedPayload: (rawBody, timestampSeconds) =>
      `${timestampSeconds}.${rawBody}`,
    encodings: ["hex", "base64"],
  },
};

export function resolveScheme(
  provider: string,
): WebhookSignatureScheme | undefined {
  const normalized = (provider ?? "").trim().toLowerCase();

  return (WEBHOOK_PROVIDERS as readonly string[]).includes(normalized)
    ? WEBHOOK_SIGNATURE_SCHEMES[normalized as WebhookProvider]
    : undefined;
}

/**
 * Timestamp seconds out of a header that may be `t=123` or a bare `123`.
 *
 * `null` means no header at all, `"missing"` means the header carried no
 * timestamp token (e.g. a Stripe `v1=`-only signature header), and
 * `"malformed"` means a timestamp was present but unparsable — the three need
 * different error messages for whoever is debugging a rejected delivery.
 */
export function extractTimestamp(
  headerValue: string | undefined,
): number | null | "missing" | "malformed" {
  if (headerValue === undefined || headerValue === null || headerValue === "") {
    return null;
  }

  const stamped = headerValue.match(/(?:^|,)\s*t=([^,]*)/);

  if (stamped) {
    const value = stamped[1].trim();

    return /^\d+$/.test(value) ? Number(value) : "malformed";
  }

  if (/^\d+$/.test(headerValue.trim())) {
    return Number(headerValue.trim());
  }

  return "missing";
}
