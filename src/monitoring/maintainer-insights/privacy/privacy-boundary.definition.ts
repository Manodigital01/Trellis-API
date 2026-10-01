import { createHmac } from "crypto";

/**
 * Privacy Boundary Specification for Maintainer Insights Analytics.
 *
 * Maintainers need usage and reliability metrics across Trellis protocol
 * operations without exposing private user data, secrets, or sensitive payload content.
 *
 * Privacy Invariants:
 * 1. Safe Dimensions Only: Aggregations group by whitelisted dimensions with bounded cardinality.
 * 2. Zero Raw Sensitive Fields: Raw IDs, wallet addresses, secret keys, tokens, PII, and payloads are rejected/scrubbed at ingestion.
 * 3. Ephemeral Pseudonymisation: If distinct actor counting is needed, actor identifiers are transformed into daily keyed HMAC-SHA256 hashes and discarded after cardinality computation.
 * 4. Bounded Retention: Ephemeral raw buffers are flushed within <=1 hour; hourly aggregates expire after 30 days; daily aggregates expire after 365 days.
 */

// ---------------------------------------------------------------------------
// 1. Whitelisted Safe Dimensions
// ---------------------------------------------------------------------------

export const SAFE_DIMENSIONS = [
  "timeBucket",
  "granularity",
  "operation",
  "route",
  "statusCategory",
  "statusCode",
  "errorCategory",
  "clientType",
  "network",
  "actorType",
] as const;

export type SafeDimension = (typeof SAFE_DIMENSIONS)[number];

export const ALLOWED_STATUS_CATEGORIES = ["2xx", "4xx", "5xx", "other"] as const;
export type StatusCategory = (typeof ALLOWED_STATUS_CATEGORIES)[number];

export const ALLOWED_NETWORKS = ["mainnet", "testnet", "sandbox", "unknown"] as const;
export type SafeNetwork = (typeof ALLOWED_NETWORKS)[number];

export const ALLOWED_CLIENT_TYPES = [
  "agent",
  "operator",
  "web",
  "indexer",
  "sdk",
  "internal",
  "unknown",
] as const;
export type SafeClientType = (typeof ALLOWED_CLIENT_TYPES)[number];

export const ALLOWED_ACTOR_TYPES = [
  "user",
  "service_actor",
  "operator",
  "admin",
  "system",
  "anonymous",
] as const;
export type SafeActorType = (typeof ALLOWED_ACTOR_TYPES)[number];

// Standard sanitized error categories (no raw error strings or payloads)
export const SAFE_ERROR_CATEGORIES = [
  "NONE",
  "VALIDATION_ERROR",
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_DENIED",
  "RATE_LIMITED",
  "NOT_FOUND",
  "CONFLICT",
  "TIMEOUT",
  "ORACLE_DRIFT",
  "ORACLE_SIGNATURE_MISMATCH",
  "RECONCILIATION_MISMATCH",
  "DEFI_INSUFFICIENT_LIQUIDITY",
  "EXTERNAL_GATEWAY_ERROR",
  "INTERNAL_ERROR",
  "UNKNOWN_ERROR",
] as const;
export type SafeErrorCategory = (typeof SAFE_ERROR_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// 2. Prohibited & Sensitive Fields
// ---------------------------------------------------------------------------

export const SENSITIVE_FIELD_NAMES = new Set<string>([
  "password",
  "passwordconfirm",
  "oldpassword",
  "newpassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "secret",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "mnemonic",
  "seed",
  "seedphrase",
  "walletpassphrase",
  "keystorepassword",
  "ssn",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "pin",
  "dateofbirth",
  "dob",
  "email",
  "phone",
  "phonenumber",
  "ip",
  "ipaddress",
  "clientip",
  "address",
  "walletaddress",
  "publickey",
  "public_key",
  "stellarsecret",
  "txhash",
  "transactionhash",
  "signature",
  "payload",
  "body",
  "requestbody",
  "responsebody",
  "details",
  "raw",
]);

// ---------------------------------------------------------------------------
// 3. Types & Interfaces
// ---------------------------------------------------------------------------

export interface RawTelemetryEvent {
  timestamp?: Date | string | number;
  operation: string;
  route?: string;
  statusCode?: number;
  latencyMs?: number;
  actorId?: string;
  actorType?: string;
  clientType?: string;
  network?: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface SanitizedTelemetryEvent {
  timeBucket: string; // ISO string truncated to hour
  operation: string;
  route: string;
  statusCode: number;
  statusCategory: StatusCategory;
  errorCategory: SafeErrorCategory;
  actorType: SafeActorType;
  clientType: SafeClientType;
  network: SafeNetwork;
  latencyMs: number;
  actorHash?: string; // Daily-keyed HMAC-SHA256, solely used for count of unique actors
}

export interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
}

export interface PrivacyBoundarySpec {
  version: string;
  policy: string;
  safeDimensions: readonly string[];
  forbiddenFields: readonly string[];
  retention: {
    ephemeralBufferMinutes: number;
    hourlyAggregatesDays: number;
    dailyAggregatesDays: number;
  };
  kAnonymity: {
    minimumActorThreshold: number;
    suppressionEnabled: boolean;
  };
  privacyProtections: string[];
}

// ---------------------------------------------------------------------------
// 4. Ingestion Sanitization & Route Normalization
// ---------------------------------------------------------------------------

/**
 * Collapse dynamic identifiers in route paths so high-cardinality values,
 * UUIDs, Stellar addresses, and hex hashes never leak into dimensions.
 */
export function normalizeRoute(rawRoute?: string): string {
  if (!rawRoute || typeof rawRoute !== "string") return "/unmatched";

  const clean = rawRoute.split("?")[0].trim();
  if (!clean || clean === "/") return "/";

  return clean
    // Replace Stellar public keys (e.g. GABCA... 56 chars)
    .replace(/\/G[A-Z2-7]{55}(\/|$)/g, "/:stellarAddress$1")
    // Replace Ethereum addresses (0x... 40 hex chars)
    .replace(/\/0x[0-9a-fA-F]{40}(\/|$)/g, "/:ethAddress$1")
    // Replace 64-char transaction hashes
    .replace(/\/[0-9a-fA-F]{64}(\/|$)/g, "/:txHash$1")
    // Replace UUIDs
    .replace(
      /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(\/|$)/g,
      "/:uuid$1",
    )
    // Replace numeric IDs
    .replace(/\/\d+(\/|$)/g, "/:id$1");
}

/**
 * Map status code to coarse status category.
 */
export function categorizeStatusCode(statusCode: number): StatusCategory {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

/**
 * Classify error message/code into safe category without preserving sensitive details.
 */
export function categorizeError(
  statusCode: number,
  errorCode?: string,
  errorMessage?: string,
): SafeErrorCategory {
  if (statusCode >= 200 && statusCode < 300) return "NONE";

  const codeUpper = (errorCode || "").toUpperCase();
  const msgLower = (errorMessage || "").toLowerCase();

  if (statusCode === 429 || codeUpper.includes("RATE_LIMIT") || msgLower.includes("rate limit")) {
    return "RATE_LIMITED";
  }
  if (statusCode === 401 || codeUpper.includes("AUTH") || msgLower.includes("unauthorized")) {
    return "AUTHENTICATION_FAILED";
  }
  if (statusCode === 403 || codeUpper.includes("FORBIDDEN") || msgLower.includes("forbidden") || msgLower.includes("kyc")) {
    return "AUTHORIZATION_DENIED";
  }
  if (statusCode === 404 || codeUpper.includes("NOT_FOUND")) {
    return "NOT_FOUND";
  }
  if (statusCode === 409 || codeUpper.includes("CONFLICT")) {
    return "CONFLICT";
  }
  if ((statusCode >= 502 && statusCode <= 504) || codeUpper.includes("GATEWAY")) {
    return "EXTERNAL_GATEWAY_ERROR";
  }
  if (statusCode === 408 || codeUpper.includes("TIMEOUT") || msgLower.includes("timeout")) {
    return "TIMEOUT";
  }
  if (codeUpper.includes("ORACLE_DRIFT") || msgLower.includes("price drift") || msgLower.includes("stale price")) {
    return "ORACLE_DRIFT";
  }
  if (codeUpper.includes("ORACLE_SIGNATURE") || msgLower.includes("oracle signature")) {
    return "ORACLE_SIGNATURE_MISMATCH";
  }
  if (codeUpper.includes("RECONCILIATION") || msgLower.includes("unmatched") || msgLower.includes("reconcil")) {
    return "RECONCILIATION_MISMATCH";
  }
  if (codeUpper.includes("LIQUIDITY") || msgLower.includes("insufficient liquidity")) {
    return "DEFI_INSUFFICIENT_LIQUIDITY";
  }
  if (statusCode === 400 || codeUpper.includes("VALIDATION") || msgLower.includes("validation")) {
    return "VALIDATION_ERROR";
  }
  if (statusCode >= 502 && statusCode <= 504) {
    return "EXTERNAL_GATEWAY_ERROR";
  }
  if (statusCode >= 500) {
    return "INTERNAL_ERROR";
  }

  return "UNKNOWN_ERROR";
}

/**
 * Truncate a date to its hourly UTC bucket.
 * e.g. 2026-09-26T21:45:12.345Z -> 2026-09-26T21:00:00.000Z
 */
export function truncateToHour(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Truncate a date to its daily UTC bucket.
 * e.g. 2026-09-26T21:45:12.345Z -> 2026-09-26T00:00:00.000Z
 */
export function truncateToDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Generate a rotating daily salt for actor hashing.
 * Salt is derived from date string and internal secret seed so it changes daily.
 */
export function getDailySalt(date: Date, secretSeed = "trellis-privacy-analytics-seed"): string {
  const dayKey = date.toISOString().slice(0, 10);
  return createHmac("sha256", secretSeed).update(dayKey).digest("hex");
}

/**
 * Hash actor ID with daily salt using HMAC-SHA256.
 * The raw actor identifier is never persisted.
 */
export function hashActorId(actorId: string, salt: string): string {
  if (!actorId) return "";
  return createHmac("sha256", salt).update(actorId.trim().toLowerCase()).digest("hex");
}

/**
 * Deep sanitise an object to confirm no sensitive fields exist.
 */
export function scrubSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase().replace(/[-_\s]/g, "");
    if (SENSITIVE_FIELD_NAMES.has(lowerKey)) {
      continue; // Drop completely
    }
    if (typeof val === "object" && val !== null && !(val instanceof Date)) {
      clean[key] = scrubSensitiveFields(val as Record<string, unknown>);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

/**
 * Ingestion Privacy Gate:
 * Sanitises a raw telemetry event into safe dimensions only.
 * Discards any raw sensitive values, secret keys, payloads, or PII.
 */
export function sanitizeTelemetryEvent(
  raw: RawTelemetryEvent,
  salt?: string,
): SanitizedTelemetryEvent {
  const eventDate = raw.timestamp ? new Date(raw.timestamp) : new Date();
  const validDate = isNaN(eventDate.getTime()) ? new Date() : eventDate;
  const timeBucket = truncateToHour(validDate).toISOString();

  // Normalize safe dimensions
  const operation = (raw.operation || "unknown.operation")
    .toLowerCase()
    .trim()
    .slice(0, 100);
  const route = normalizeRoute(raw.route);
  const statusCode = typeof raw.statusCode === "number" && raw.statusCode >= 100 && raw.statusCode <= 599
    ? raw.statusCode
    : 200;
  const statusCategory = categorizeStatusCode(statusCode);
  const errorCategory = categorizeError(statusCode, raw.errorCode, raw.errorMessage);

  const clientType = (
    ALLOWED_CLIENT_TYPES.includes(raw.clientType as SafeClientType)
      ? raw.clientType
      : "unknown"
  ) as SafeClientType;

  const network = (
    ALLOWED_NETWORKS.includes(raw.network as SafeNetwork)
      ? raw.network
      : "unknown"
  ) as SafeNetwork;

  const actorType = (
    ALLOWED_ACTOR_TYPES.includes(raw.actorType as SafeActorType)
      ? raw.actorType
      : "anonymous"
  ) as SafeActorType;

  const latencyMs = Math.max(0, Number(raw.latencyMs) || 0);

  // Pseudonymise actor identifier if present; discard raw actorId
  let actorHash: string | undefined;
  if (raw.actorId) {
    const activeSalt = salt || getDailySalt(validDate);
    actorHash = hashActorId(raw.actorId, activeSalt);
  }

  return {
    timeBucket,
    operation,
    route,
    statusCode,
    statusCategory,
    errorCategory,
    actorType,
    clientType,
    network,
    latencyMs,
    actorHash,
  };
}

/**
 * Calculate statistical quantiles and summary from an array of latencies.
 */
export function calculateLatencyStats(latencies: number[]): LatencyStats {
  if (!latencies || latencies.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p99Ms: 0,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = parseFloat((sum / count).toFixed(2));
  const min = sorted[0];
  const max = sorted[count - 1];

  const quantile = (q: number): number => {
    const pos = (count - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return parseFloat((sorted[base] + rest * (sorted[base + 1] - sorted[base])).toFixed(2));
    }
    return parseFloat(sorted[base].toFixed(2));
  };

  return {
    count,
    minMs: min,
    maxMs: max,
    avgMs: avg,
    p50Ms: quantile(0.5),
    p90Ms: quantile(0.9),
    p99Ms: quantile(0.99),
  };
}

/**
 * Returns formal Privacy Boundary Specification for audit and introspection.
 */
export function getPrivacyBoundarySpecification(): PrivacyBoundarySpec {
  return {
    version: "1.0.0",
    policy:
      "Trellis Maintainer Insights Privacy-Preserving Analytics Specification. " +
      "Guarantees that metrics aggregation operates strictly on safe, low-cardinality dimensions. " +
      "Raw identities, wallets, secrets, and payload content are strictly prohibited and discarded at ingestion.",
    safeDimensions: SAFE_DIMENSIONS,
    forbiddenFields: Array.from(SENSITIVE_FIELD_NAMES),
    retention: {
      ephemeralBufferMinutes: 60,
      hourlyAggregatesDays: 30,
      dailyAggregatesDays: 365,
    },
    kAnonymity: {
      minimumActorThreshold: 1, // Minimum unique actors before publishing bucket
      suppressionEnabled: true,
    },
    privacyProtections: [
      "Dynamic path normalization (UUIDs, addresses, tx hashes stripped)",
      "Strict field dropping: no raw user IDs, Stellar public/private keys, or tokens",
      "Daily-keyed HMAC pseudonymisation for ephemeral distinct actor counts",
      "Bounded statistical aggregation: only count, sum, min, max, avg, quantiles",
      "Enforced retention lifecycle with automated cleanup jobs",
    ],
  };
}
