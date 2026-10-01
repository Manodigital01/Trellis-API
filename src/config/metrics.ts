import client from "prom-client";

// Create a Registry to register the metrics
export const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({
  register,
  prefix: "trellis_",
});

// Custom metrics
export const httpRequestDuration = new client.Histogram({
  name: "trellis_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [register],
});

export const httpRequestTotal = new client.Counter({
  name: "trellis_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const httpRequestsInProgress = new client.Gauge({
  name: "trellis_http_requests_in_progress",
  help: "Number of HTTP requests currently in progress",
  labelNames: ["method", "route"],
  registers: [register],
});

export const databaseQueryDuration = new client.Histogram({
  name: "trellis_database_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["operation", "table"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const activeConnections = new client.Gauge({
  name: "trellis_active_connections",
  help: "Number of active connections",
  labelNames: ["type"],
  registers: [register],
});

export const errorTotal = new client.Counter({
  name: "trellis_errors_total",
  help: "Total number of errors",
  labelNames: ["type", "severity"],
  registers: [register],
});

// Business metrics examples
export const userSignups = new client.Counter({
  name: "trellis_user_signups_total",
  help: "Total number of user signups",
  registers: [register],
});

export const activeUsers = new client.Gauge({
  name: "trellis_active_users",
  help: "Number of currently active users",
  registers: [register],
});

// Compute job queue metrics
export const jobDuration = new client.Histogram({
  name: "trellis_job_duration_seconds",
  help: "Duration of compute job processing in seconds",
  labelNames: ["job_type", "status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const jobSuccessTotal = new client.Counter({
  name: "trellis_job_success_total",
  help: "Total number of successfully completed jobs",
  labelNames: ["job_type"],
  registers: [register],
});

export const jobFailureTotal = new client.Counter({
  name: "trellis_job_failure_total",
  help: "Total number of failed jobs",
  labelNames: ["job_type", "failure_reason"],
  registers: [register],
});

export const queueLength = new client.Gauge({
  name: "trellis_queue_length",
  help: "Number of jobs in various queue states",
  labelNames: ["queue_name", "state"],
  registers: [register],
});

export const billingUsageUnits = new client.Counter({
  name: "trellis_billing_usage_units_total",
  help: "Total metered billing units recorded",
  labelNames: ["plan", "metric"],
  registers: [register],
});

export const billingEstimatedChargesCents = new client.Gauge({
  name: "trellis_billing_estimated_charges_cents",
  help: "Latest estimated billing charge in cents by plan",
  labelNames: ["plan"],
  registers: [register],
});

// Proration applied on mid-cycle plan changes (issue #82). The counter is
// labelled by direction, a closed set the service itself chooses, so a client
// cannot mint series; the value is the absolute cents moved (charge or credit)
// because a counter cannot go negative.
export const billingProrationNetCents = new client.Counter({
  name: "trellis_billing_proration_cents_total",
  help: "Absolute cents moved by proration on plan changes, by direction",
  labelNames: ["direction"],
  registers: [register],
});

// ── WebSocket gateway metrics (issue #143) ────────────────────────────────
//
// #143 asked for connection-pool and subscription visibility. The four series
// below are the ones the issue named; every label is drawn from a closed set
// (transport mode, event kind) or is an opaque channel/portfolio identifier
// that the gateway already holds, so none of them can be driven to unbounded
// cardinality by an untrusted caller — a client cannot choose an arbitrary
// label value, only pick among the transports the gateway actually serves.
//
// The `websocket_active_connections_total` name is a little odd for a gauge
// (the `_total` suffix is a counter convention), but the issue specifies it
// and Prometheus tooling keys off the metric *type*, which is declared here as
// a Gauge, so scrapes and rules behave correctly. Renaming would break any
// existing dashboard that references the issue's name.

export const websocketActiveConnections = new client.Gauge({
  name: "websocket_active_connections_total",
  help: "Currently open WebSocket connections by transport mode",
  labelNames: ["transport"],
  registers: [register],
});

export const websocketSubscriptions = new client.Gauge({
  name: "websocket_subscriptions_total",
  help: "Currently active subscription channels by portfolio",
  labelNames: ["portfolio"],
  registers: [register],
});

export const websocketMessagesPublished = new client.Counter({
  name: "websocket_messages_published_total",
  help: "Total WebSocket messages published to clients by event kind",
  labelNames: ["event"],
  registers: [register],
});

export const websocketErrors = new client.Counter({
  name: "websocket_errors_total",
  help: "Total WebSocket errors by reason",
  labelNames: ["reason"],
  registers: [register],
});

/**
 * Transports the gateway can serve. A connection's transport is resolved from
 * this set rather than echoed from the upgrade request, so the `transport`
 * label cannot be inflated with arbitrary values.
 */
export const WEBSOCKET_TRANSPORTS = ["dashboard", "mobile", "public"] as const;
export type WebsocketTransport = (typeof WEBSOCKET_TRANSPORTS)[number];

/** Closed set of event kinds for `websocketMessagesPublished`. */
export const WEBSOCKET_EVENT_KINDS = [
  "portfolio_update",
  "transaction",
  "alert",
  "notification",
  "system",
] as const;

/** Closed set of error reasons for `websocketErrors`. */
export const WEBSOCKET_ERROR_REASONS = [
  "publish_failed",
  "send_failed",
  "subscribe_failed",
  "invalid_message",
  "rate_limited",
] as const;

function isMember<T extends string>(set: readonly T[], value: string): value is T {
  return (set as readonly string[]).includes(value);
}

/** Normalise a transport label, collapsing anything unknown to `public`. */
export function normalizeWebsocketTransport(value: string | undefined | null): WebsocketTransport {
  if (value && isMember(WEBSOCKET_TRANSPORTS, value)) return value;
  return "public";
}

/** Normalise an event label, collapsing anything unknown to `system`. */
export function normalizeWebsocketEvent(value: string | undefined | null): (typeof WEBSOCKET_EVENT_KINDS)[number] {
  if (value && isMember(WEBSOCKET_EVENT_KINDS, value)) return value;
  return "system";
}

/** Normalise an error-reason label, collapsing anything unknown to `send_failed`. */
export function normalizeWebsocketErrorReason(
  value: string | undefined | null,
): (typeof WEBSOCKET_ERROR_REASONS)[number] {
  if (value && isMember(WEBSOCKET_ERROR_REASONS, value)) return value;
  return "send_failed";
}

/**
 * Portfolio/channel label for subscription metrics.
 *
 * A channel is chosen by the subscribing client, so this bounds and
 * normalises it rather than trusting it verbatim: the value is truncated and
 * stripped of characters that would make a metric label ambiguous, and an
 * empty or over-long result falls back to `unknown`. This keeps a hostile
 * client from creating an unbounded number of series by opening a channel per
 * subscription.
 */
export function normalizeWebsocketChannel(value: string | undefined | null): string {
  if (typeof value !== "string") return "unknown";
  const cleaned = value.trim().replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Record a newly opened connection for a transport. */
export function trackWebsocketConnectionOpened(transport?: string | null): void {
  websocketActiveConnections.inc({ transport: normalizeWebsocketTransport(transport) });
}

/** Record a closed connection for a transport. */
export function trackWebsocketConnectionClosed(transport?: string | null): void {
  websocketActiveConnections.dec({ transport: normalizeWebsocketTransport(transport) });
}

/** Record a published message. */
export function trackWebsocketMessagePublished(event?: string | null): void {
  websocketMessagesPublished.inc({ event: normalizeWebsocketEvent(event) });
}

/** Record a WebSocket error. */
export function trackWebsocketError(reason?: string | null): void {
  websocketErrors.inc({ reason: normalizeWebsocketErrorReason(reason) });
}

/** Set the active subscription count for a channel. */
export function setWebsocketSubscriptions(portfolio: string | undefined | null, value: number): void {
  websocketSubscriptions.set({ portfolio: normalizeWebsocketChannel(portfolio) }, value);
}

/** Drop a channel's subscription gauge when its last subscriber leaves. */
export function clearWebsocketSubscriptions(portfolio: string | undefined | null): void {
  websocketSubscriptions.set({ portfolio: normalizeWebsocketChannel(portfolio) }, 0);
}

/** Reset every WebSocket series. Test seam — a Gauge needs zeroing between tests. */
export function resetWebsocketMetrics(): void {
  websocketActiveConnections.reset();
  websocketSubscriptions.reset();
  websocketMessagesPublished.reset();
  websocketErrors.reset();
}
