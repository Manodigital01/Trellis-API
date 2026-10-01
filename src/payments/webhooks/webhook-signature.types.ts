/** Providers whose incoming webhooks are signature-verified. */
export const WEBHOOK_PROVIDERS = ["stripe", "coinbase", "generic"] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export type WebhookSignatureFailureReason =
  | "unknown_provider"
  | "secret_not_configured"
  | "raw_body_unavailable"
  | "missing_signature"
  | "malformed_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "invalid_signature";

export interface WebhookVerificationSuccess {
  ok: true;
  provider: WebhookProvider;
  /** Unix seconds the provider signed with, when the scheme carries one. */
  timestampSeconds: number | null;
}

export interface WebhookVerificationFailure {
  ok: false;
  reason: WebhookSignatureFailureReason;
  /**
   * `400` for anything the caller got wrong, `503` when the server itself is
   * misconfigured (no secret for that provider) — a missing secret is not the
   * sender's fault, and answering `400` would send them hunting for a payload
   * bug that does not exist.
   */
  status: 400 | 503;
  message: string;
}

export type WebhookVerification =
  | WebhookVerificationSuccess
  | WebhookVerificationFailure;

export interface WebhookVerificationInput {
  /** Provider segment from the route, e.g. `stripe`. */
  provider: string;
  /** Lower-cased request headers. */
  headers: Record<string, string | string[] | undefined>;
  /** The exact bytes received, before any JSON parsing. */
  rawBody?: Buffer | string | null;
  /** Injected clock (tests); defaults to `Date.now()`. */
  now?: number;
}
