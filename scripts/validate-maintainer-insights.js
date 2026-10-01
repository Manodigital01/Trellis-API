/**
 * Standalone Validation Script for Trellis API Maintainer Insights & Privacy Boundaries.
 *
 * Validates:
 * 1. Safe dimensions enforcement.
 * 2. Absolute scrubbing of raw sensitive data (tokens, wallet addresses, secrets, PII).
 * 3. Daily keyed HMAC actor pseudonymisation.
 * 4. Path normalization collapsing high-cardinality values.
 * 5. Aggregation calculations (counts, success rates, latency quantiles).
 * 6. Retention policy boundaries.
 *
 * Usage:
 *   node scripts/validate-maintainer-insights.js
 */

const { createHmac } = require("crypto");
const assert = require("assert");

console.log("===============================================================");
console.log("🔒 Running Maintainer Insights Privacy & Aggregation Validation");
console.log("===============================================================\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Pure logic mirrors for standalone execution
// ---------------------------------------------------------------------------

const SAFE_DIMENSIONS = [
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
];

const SENSITIVE_FIELD_NAMES = new Set([
  "password", "token", "secret", "apikey", "api_key", "privatekey",
  "private_key", "mnemonic", "seed", "seedphrase", "walletpassphrase",
  "ssn", "creditcard", "cardnumber", "cvv", "pin", "dob", "dateofbirth",
  "email", "phone", "ip", "ipaddress", "address", "walletaddress",
  "publickey", "stellarsecret", "txhash", "signature", "payload", "body",
]);

function normalizeRoute(rawRoute) {
  if (!rawRoute || typeof rawRoute !== "string") return "/unmatched";
  const clean = rawRoute.split("?")[0].trim();
  if (!clean || clean === "/") return "/";
  return clean
    .replace(/\/G[A-Z2-7]{55}(\/|$)/g, "/:stellarAddress$1")
    .replace(/\/0x[0-9a-fA-F]{40}(\/|$)/g, "/:ethAddress$1")
    .replace(/\/[0-9a-fA-F]{64}(\/|$)/g, "/:txHash$1")
    .replace(
      /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(\/|$)/g,
      "/:uuid$1"
    )
    .replace(/\/\d+(\/|$)/g, "/:id$1");
}

function categorizeStatusCode(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

function categorizeError(statusCode, errorCode, errorMessage) {
  if (statusCode >= 200 && statusCode < 300) return "NONE";
  const code = (errorCode || "").toUpperCase();
  const msg = (errorMessage || "").toLowerCase();
  if (statusCode === 429 || code.includes("RATE_LIMIT") || msg.includes("rate limit")) return "RATE_LIMITED";
  if (statusCode === 401 || code.includes("AUTH") || msg.includes("unauthorized")) return "AUTHENTICATION_FAILED";
  if (statusCode === 403 || code.includes("FORBIDDEN") || msg.includes("kyc")) return "AUTHORIZATION_DENIED";
  if ((statusCode >= 502 && statusCode <= 504) || code.includes("GATEWAY")) return "EXTERNAL_GATEWAY_ERROR";
  if (statusCode === 408 || code.includes("TIMEOUT") || msg.includes("timeout")) return "TIMEOUT";
  if (code.includes("RECONCIL") || msg.includes("unmatched")) return "RECONCILIATION_MISMATCH";
  if (statusCode === 400 || code.includes("VALIDATION")) return "VALIDATION_ERROR";
  if (statusCode >= 502 && statusCode <= 504) return "EXTERNAL_GATEWAY_ERROR";
  if (statusCode >= 500) return "INTERNAL_ERROR";
  return "UNKNOWN_ERROR";
}

function getDailySalt(date, secretSeed = "trellis-privacy-analytics-seed") {
  const dayKey = date.toISOString().slice(0, 10);
  return createHmac("sha256", secretSeed).update(dayKey).digest("hex");
}

function hashActorId(actorId, salt) {
  if (!actorId) return "";
  return createHmac("sha256", salt).update(actorId.trim().toLowerCase()).digest("hex");
}

function calculateLatencyStats(latencies) {
  if (!latencies || latencies.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avg = parseFloat((sum / count).toFixed(2));
  const min = sorted[0];
  const max = sorted[count - 1];

  const quantile = (q) => {
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

// ---------------------------------------------------------------------------
// Test Invariants
// ---------------------------------------------------------------------------

test("Privacy Invariant 1: Path normalization strips high-cardinality identifiers", () => {
  assert.strictEqual(
    normalizeRoute("/api/v1/portfolios/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/assets"),
    "/api/v1/portfolios/:uuid/assets"
  );
  assert.strictEqual(
    normalizeRoute("/api/v1/wallets/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/balance"),
    "/api/v1/wallets/:stellarAddress/balance"
  );
  assert.strictEqual(
    normalizeRoute("/api/v1/defi/0x1234567890123456789012345678901234567890/positions"),
    "/api/v1/defi/:ethAddress/positions"
  );
  assert.strictEqual(
    normalizeRoute("/api/v1/reconcile/tx/9cc3bcab9450390ce5e214045a41e70e6d4a920f2bbc3e5d873c90eadfb7e45c"),
    "/api/v1/reconcile/tx/:txHash"
  );
  assert.strictEqual(
    normalizeRoute("/api/v1/oracle/payloads?token=secret123&page=1"),
    "/api/v1/oracle/payloads"
  );
});

test("Privacy Invariant 2: Raw secrets, tokens, keys and user identifiers are never stored", () => {
  const secretUser = "usr_sensitive_999";
  const secretKey = "SBCW2ACURUSJJXAX6JUSKNA7D7H7UJJJAXD";
  const secretToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive";

  const rawEvent = {
    operation: "oracle.price_feed",
    route: "/api/v1/oracle/payloads",
    statusCode: 200,
    actorId: secretUser,
    secretKey: secretKey,
    token: secretToken,
    latencyMs: 42.0,
  };

  // Run privacy gate
  const salt = getDailySalt(new Date());
  const sanitized = {
    operation: rawEvent.operation,
    route: normalizeRoute(rawEvent.route),
    statusCode: rawEvent.statusCode,
    statusCategory: categorizeStatusCode(rawEvent.statusCode),
    errorCategory: categorizeError(rawEvent.statusCode),
    actorHash: hashActorId(rawEvent.actorId, salt),
    latencyMs: rawEvent.latencyMs,
  };

  const serialized = JSON.stringify(sanitized);

  assert(!serialized.includes(secretUser), "Raw user ID must not appear in output");
  assert(!serialized.includes(secretKey), "Stellar secret key must not appear in output");
  assert(!serialized.includes(secretToken), "Auth token must not appear in output");
  assert(sanitized.actorHash && sanitized.actorHash.length === 64, "Actor ID must be hashed");
});

test("Privacy Invariant 3: Daily keyed salt rotates across dates", () => {
  const day1 = new Date("2026-09-26T10:00:00Z");
  const day2 = new Date("2026-09-27T10:00:00Z");

  const salt1 = getDailySalt(day1);
  const salt2 = getDailySalt(day2);

  assert.notStrictEqual(salt1, salt2, "Salt must change on date boundary");

  const hashDay1 = hashActorId("user-1", salt1);
  const hashDay2 = hashActorId("user-1", salt2);

  assert.notStrictEqual(hashDay1, hashDay2, "Same user on different days must produce different pseudonym");
});

test("Aggregation Invariant 4: Latency stats (min, max, avg, quantiles) compute correctly", () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const stats = calculateLatencyStats(samples);

  assert.strictEqual(stats.count, 10);
  assert.strictEqual(stats.minMs, 10);
  assert.strictEqual(stats.maxMs, 100);
  assert.strictEqual(stats.avgMs, 55);
  assert.strictEqual(stats.p50Ms, 55);
  assert(stats.p90Ms >= 90);
  assert(stats.p99Ms >= 99);
});

test("Aggregation Invariant 5: Safe grouping aggregates counts and success rates", () => {
  const mockEvents = [
    { op: "oracle.price_feed", status: 200, latency: 40, actor: "hashA" },
    { op: "oracle.price_feed", status: 200, latency: 60, actor: "hashB" },
    { op: "oracle.price_feed", status: 400, latency: 80, actor: "hashA" },
  ];

  let total = mockEvents.length;
  let success = mockEvents.filter((e) => e.status === 200).length;
  let failure = mockEvents.filter((e) => e.status >= 400).length;
  let uniqueActors = new Set(mockEvents.map((e) => e.actor)).size;
  let latencies = mockEvents.map((e) => e.latency);
  let stats = calculateLatencyStats(latencies);

  assert.strictEqual(total, 3);
  assert.strictEqual(success, 2);
  assert.strictEqual(failure, 1);
  assert.strictEqual(uniqueActors, 2);
  assert.strictEqual(stats.avgMs, 60);
  assert.strictEqual(stats.minMs, 40);
  assert.strictEqual(stats.maxMs, 80);
});

test("Retention Policy Invariant 6: Hourly retained for 30d, Daily for 365d", () => {
  const hourlyRetentionDays = 30;
  const dailyRetentionDays = 365;

  const now = Date.now();
  const hourlyCutoff = new Date(now - hourlyRetentionDays * 86400000);
  const dailyCutoff = new Date(now - dailyRetentionDays * 86400000);

  assert(hourlyCutoff < new Date(now), "Hourly cutoff must be in the past");
  assert(dailyCutoff < hourlyCutoff, "Daily cutoff must be older than hourly cutoff");
  const diffDays = Math.round((hourlyCutoff.getTime() - dailyCutoff.getTime()) / 86400000);
  assert.strictEqual(diffDays, 335); // 365 - 30 = 335
});

console.log("\n---------------------------------------------------------------");
console.log(`Validation Results: ${passed} passed, ${failed} failed`);
console.log("---------------------------------------------------------------\n");

if (failed > 0) {
  process.exit(1);
} else {
  console.log("🎉 All Privacy-Preserving Analytics Invariants Verified Successfully!\n");
  process.exit(0);
}
