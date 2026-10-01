# Privacy-Preserving Analytics & Maintainer Insights

Trellis API provides privacy-preserving usage and reliability analytics designed specifically for maintainers, operators, and developers. It provides high-signal operational visibility without exposing private user data, wallet addresses, secrets, or sensitive payload content.

---

## 1. Architecture & Privacy Invariants

The analytics pipeline operates under five inviolable privacy boundaries:

```
┌────────────────────────────────────────────────────────┐
│               Trellis Protocol Operations              │
│  (Oracles, Rebalancing, DeFi, Stellar Reconciliation)   │
└───────────────────────────┬────────────────────────────┘
                            │ Raw Operation Context
                            ▼
┌────────────────────────────────────────────────────────┐
│          Privacy Ingestion Gate (PrivacyGuard)         │
│  • Discard raw IDs, wallet addresses, tokens, secrets  │
│  • Normalize routes (/wallets/:stellarAddress/balance) │
│  • Hash actor ID with daily rotating HMAC-SHA256 salt  │
│  • Map errors to safe categories (no raw payloads)    │
└───────────────────────────┬────────────────────────────┘
                            │ Sanitized Safe Dimensions Only
                            ▼
┌────────────────────────────────────────────────────────┐
│           Ephemeral In-Memory Ring Buffer              │
│  • Max buffer capacity (10,000 events)                 │
│  • TTL <= 60 minutes; never persisted to raw disk logs │
└───────────────────────────┬────────────────────────────┘
                            │ Hourly Rollup Job (@Cron)
                            ▼
┌────────────────────────────────────────────────────────┐
│        Maintainer Aggregate Metrics (PostgreSQL)       │
│  • Dimension tuples (bucket, op, route, status, net)   │
│  • Counts, success rates, latency quantiles (p50/p90)  │
│  • Unique active actor count (cardinality only)        │
└───────────────────────────┬────────────────────────────┘
                            │ Daily Rollup & Retention Job
                            ▼
┌────────────────────────────────────────────────────────┐
│      Retention Lifecycle & Maintainer Insights API     │
│  • Hourly: 30 days retention                           │
│  • Daily: 365 days retention                           │
│  • GET /api/v1/monitoring/maintainer-insights/*        │
└────────────────────────────────────────────────────────┘
```

### Invariant 1: Safe Dimensions Whitelist Only
All aggregations are grouped strictly by low-cardinality, non-identifying dimensions:

| Dimension | Type | Description & Examples |
| :--- | :--- | :--- |
| `timeBucket` | ISO Timestamp | Hourly or daily truncated UTC timestamp (e.g. `2026-09-26T14:00:00.000Z`) |
| `granularity` | Enum | `'hourly'` or `'daily'` |
| `operation` | String | Dot-notated Trellis protocol operation (`'oracle.price_feed'`, `'reconciliation.stellar'`, `'portfolio.rebalance'`, `'auth.challenge'`) |
| `route` | String | Normalized API path pattern (`'/api/v1/oracle/payloads'`, `'/api/v1/portfolios/:uuid/rebalance'`) |
| `statusCategory`| Enum | Coarse HTTP status class (`'2xx'`, `'4xx'`, `'5xx'`, `'other'`) |
| `statusCode` | Number | Canonical HTTP status code (`200`, `400`, `401`, `429`, `500`) |
| `errorCategory` | Enum | Standardized error category (`'VALIDATION_ERROR'`, `'RATE_LIMITED'`, `'ORACLE_DRIFT'`, `'RECONCILIATION_MISMATCH'`, `'INTERNAL_ERROR'`) |
| `clientType` | Enum | Client tier (`'agent'`, `'operator'`, `'web'`, `'indexer'`, `'sdk'`, `'unknown'`) |
| `network` | Enum | Network environment (`'mainnet'`, `'testnet'`, `'sandbox'`) |
| `actorType` | Enum | Role class (`'user'`, `'service_actor'`, `'operator'`, `'admin'`, `'system'`, `'anonymous'`) |

### Invariant 2: Prohibited Sensitive Fields Scrubbed at Ingestion
The following fields are strictly prohibited and discarded immediately at the ingestion gate before entering any buffer or storage:
- **User Identifiers:** `userId`, `user_id`, `sub`, `account_id`, `email`, `phone`, `ipAddress`
- **Crypto & Wallet Credentials:** Stellar public addresses (`G...`), Stellar secret keys (`S...`), Ethereum addresses (`0x...`), private keys, seed phrases, mnemonics, wallet passphrases
- **Auth Credentials:** Passwords, API keys, JWT access tokens, refresh tokens, bearer headers, session tokens
- **Transaction & Payload Content:** Transaction hashes, nonces, signatures, request bodies, response bodies, query string secrets

### Invariant 3: Dynamic Path Normalization
Raw URLs are collapsed to prevent variable path parameters from leaking identities or increasing metric cardinality:
- UUIDs (`[0-9a-fA-F-]{36}`) &rarr; `:uuid`
- Stellar public keys (`G[A-Z2-7]{55}`) &rarr; `:stellarAddress`
- Ethereum addresses (`0x[0-9a-fA-F]{40}`) &rarr; `:ethAddress`
- Hex transaction hashes (`[0-9a-fA-F]{64}`) &rarr; `:txHash`
- Numeric IDs (`/\d+/`) &rarr; `:id`
- Query parameters (`?...`) &rarr; stripped

### Invariant 4: Ephemeral Actor Pseudonymisation & Cardinality
Maintainers need to know "how many unique agents or users were active", but must not know *who* they are.
- When an `actorId` is supplied, it is transformed using HMAC-SHA256 with a **daily rotating salt**:
  $$\text{pseudonym} = \text{HMAC-SHA256}(\text{dailySalt}, \text{actorId})$$
- Because the salt rotates every UTC day at 00:00, pseudonyms cannot be correlated across days.
- In persistent aggregates, only the integer count of distinct pseudonyms (`uniqueActorsCount`) is saved. The pseudonyms themselves are discarded.

---

## 2. Metric Aggregation & Statistical Distributions

Each aggregate record in `maintainer_aggregate_metrics` stores:

```typescript
export class MaintainerAggregateMetric {
  dateBucket: Date;             // Start of time bucket
  granularity: 'hourly' | 'daily';
  operation: string;            // e.g. "oracle.price_feed"
  route: string;                // e.g. "/api/v1/oracle/payloads"
  statusCategory: string;       // "2xx" | "4xx" | "5xx"
  statusCode: number;           // e.g. 200
  errorCategory: string;        // e.g. "NONE" or "ORACLE_DRIFT"
  clientType: string;           // "agent" | "operator" | "web"
  network: string;              // "mainnet" | "testnet" | "sandbox"
  actorType: string;            // "service_actor" | "user"

  // Volume & Reliability Counts
  totalEvents: number;          // Total requests/operations
  successCount: number;         // Count of 2xx outcomes
  failureCount: number;         // Count of >=400 outcomes
  uniqueActorsCount: number;    // Count of distinct active actors

  // Latency Quantiles (ms)
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;         // Median latency
  p90LatencyMs: number;         // 90th percentile
  p99LatencyMs: number;         // 99th percentile

  // Error Breakdown
  errorBreakdown: Record<string, number>; // { "RATE_LIMITED": 12, "TIMEOUT": 2 }
}
```

---

## 3. Data Retention Lifecycle

| Storage Tier | Medium | Retention Period | Purge Trigger |
| :--- | :--- | :--- | :--- |
| **Ephemeral In-Memory Buffer** | Node.js Memory | Max 60 minutes | Flushed by hourly aggregation job or FIFO eviction when full |
| **Hourly Aggregates** | PostgreSQL (`maintainer_aggregate_metrics`) | **30 days** (`ANALYTICS_HOURLY_RETENTION_DAYS`) | Scheduled daily retention cleaner job (`@Cron('15 2 * * *')`) |
| **Daily Aggregates** | PostgreSQL (`maintainer_aggregate_metrics`) | **365 days** (`ANALYTICS_DAILY_RETENTION_DAYS`) | Scheduled daily retention cleaner job (`@Cron('15 2 * * *')`) |

### Automated Background Workers (`MaintainerInsightsJobService`):
1. **Hourly Rollup Job (`1 * * * *`):** Runs at minute 1 of every hour. Drains the ephemeral buffer and inserts hourly `MaintainerAggregateMetric` rows.
2. **Daily Rollup Job (`5 1 * * *`):** Runs at 01:05 UTC daily. Consolidates previous day's hourly rows into daily trend rows.
3. **Retention Cleaner Job (`15 2 * * *`):** Runs at 02:15 UTC daily. Purges hourly rows older than 30 days and daily rows older than 365 days.

---

## 4. API Endpoints for Maintainers

All maintainer insights endpoints are routed under `/api/v1/monitoring/maintainer-insights` and protected with `JwtAuthGuard`, `RolesGuard`, `AdminTwoFactorGuard` (`Role.ADMIN`, `Role.OPERATOR`). They can also be accessed via `METRICS_AUTH_TOKEN` (Bearer token or `X-API-Key`).

### 4.1 `GET /api/v1/monitoring/maintainer-insights/summary`
Returns high-level usage, success rates, latency quantiles, and breakdowns:

**Response Example (200 OK):**
```json
{
  "timestamp": "2026-09-26T22:00:00.000Z",
  "window": {
    "granularity": "hourly"
  },
  "totals": {
    "totalEvents": 14250,
    "totalSuccess": 13980,
    "totalFailure": 270,
    "successRatePercent": 98.11,
    "distinctActiveActors": 48,
    "avgLatencyMs": 48.35
  },
  "byOperation": {
    "oracle.price_feed": {
      "events": 8200,
      "successRatePercent": 99.4,
      "avgLatencyMs": 32.1
    },
    "reconciliation.stellar": {
      "events": 2100,
      "successRatePercent": 97.2,
      "avgLatencyMs": 112.5
    }
  },
  "byErrorCategory": {
    "RATE_LIMITED": 180,
    "ORACLE_DRIFT": 90
  },
  "byClientType": {
    "agent": 11000,
    "operator": 3250
  },
  "byNetwork": {
    "mainnet": 12000,
    "testnet": 2250
  },
  "trend": [
    {
      "dateBucket": "2026-09-26T21:00:00.000Z",
      "events": 7100,
      "failures": 130,
      "avgLatencyMs": 47.9
    }
  ]
}
```

### 4.2 `GET /api/v1/monitoring/maintainer-insights/timeseries`
Query filtered aggregate buckets.

**Query Parameters:**
- `from` (ISO string): Start date
- `to` (ISO string): End date
- `granularity`: `'hourly'` or `'daily'`
- `operation`: Filter by operation (e.g. `oracle.price_feed`)
- `statusCategory`: Filter by `2xx`, `4xx`, `5xx`
- `errorCategory`: Filter by safe error category
- `network`: Filter by `mainnet`, `testnet`, `sandbox`
- `clientType`: Filter by `agent`, `operator`, `web`
- `limit` (default 100, max 1000)
- `offset` (default 0)

### 4.3 `GET /api/v1/monitoring/maintainer-insights/reliability`
Returns protocol reliability metrics, high-failure operations, and slowest bottlenecks.

### 4.4 `GET /api/v1/monitoring/maintainer-insights/privacy-boundaries`
Introspection endpoint that returns the machine-readable privacy contract so external auditors, clients, and automated compliance tools can programmatically verify privacy invariants.

### 4.5 `POST /api/v1/monitoring/maintainer-insights/aggregate`
Manually trigger an on-demand flush and aggregation cycle.

### 4.6 `POST /api/v1/monitoring/maintainer-insights/retention/cleanup`
Manually trigger an on-demand retention purge.

---

## 5. Verification & Tests

### Standalone Privacy & Aggregation Validation Script
To verify privacy invariants, route normalization, error categorization, and retention bounds without external dependencies:

```bash
npm run validate:maintainer-insights
# or directly:
node scripts/validate-maintainer-insights.js
```

### Automated Unit & Invariant Tests
```bash
npx jest src/monitoring/maintainer-insights/maintainer-insights.spec.ts
```
