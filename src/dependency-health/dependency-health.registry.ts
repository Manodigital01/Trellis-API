/**
 * Registry of the external services, networks and configuration assumptions
 * Trellis API depends on.
 *
 * Each entry is a pure function of a {@link DependencyProbeContext}: the same
 * definition is used by the REST endpoint, the maintainer CLI and the unit
 * tests. Adding a dependency means adding one definition here — no other file
 * needs to change.
 *
 * The registry intentionally covers the three failure classes called out in
 * issue #124:
 *   1. services the API cannot work without (PostgreSQL, Redis, Stellar
 *      Horizon, the EVM JSON-RPC used by the oracle);
 *   2. network assumptions (hosts, ports, TLS endpoints, RPC chain ids);
 *   3. configuration assumptions (network passphrases, storage backends,
 *      DSN shape, chain id agreement).
 *
 * Issue: #124
 */

import {
  DependencyDefinition,
  DependencyProbeContext,
  DependencyProbeOutcome,
} from "./dependency-health.types";
import {
  applyLatencyBudget,
  classifyHttpOutcome,
  classifyThrownError,
  disabledOutcome,
  errorMessage,
  firstConfigured,
  isConfigured,
  isTimeoutError,
  misconfiguredOutcome,
  resolveHostPort,
  sanitizeTarget,
} from "./dependency-health.probe-kit";

const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";
const DEFAULT_ELASTICSEARCH_URL = "http://localhost:9200";

/** Passphrases a Stellar deployment may legitimately use. */
const KNOWN_NETWORK_PASSPHRASES = [
  "Public Global Stellar Network ; September 2015",
  "Test SDF Network ; September 2015",
  "Sandbox SDF Network ; September 2015",
];

const database: DependencyDefinition = {
  id: "database",
  label: "PostgreSQL (TypeORM DataSource)",
  kind: "service",
  criticality: "critical",
  configKeys: ["DATABASE_URL", "JWT_SECRET", "DB_DATABASE"],
  // DB_DATABASE only overrides the database named inside DATABASE_URL, so it
  // stays optional; a missing signing key is not a database problem.
  requiredConfigKeys: ["DATABASE_URL", "JWT_SECRET"],
  remediation: {
    misconfigured:
      "Set DATABASE_URL to a reachable PostgreSQL connection string, then run `npm run diagnostics` to verify the credentials.",
    unavailable:
      "Start or restore PostgreSQL, confirm the host/port in DATABASE_URL is routable from this process, and check the connection pool limit (extra.max = 20).",
    degraded:
      "Database round trips are slower than the configured budget. Check connection pool saturation and slow queries before raising DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    if (!isConfigured(context.env.DATABASE_URL)) {
      return misconfiguredOutcome("DATABASE_URL is not set", ["DB_DATABASE"]);
    }
    if (!isConfigured(context.env.JWT_SECRET)) {
      return misconfiguredOutcome("JWT_SECRET is not set");
    }
    try {
      const { latencyMs } = await context.query(
        "postgres",
        context.timeoutMs,
      );
      return {
        state: applyLatencyBudget(latencyMs, context.degradedLatencyMs),
        detail: `SELECT 1 succeeded in ${latencyMs}ms`,
        latencyMs,
        target: sanitizeTarget(context.env.DATABASE_URL as string),
        verification: "database",
      };
    } catch (error) {
      const state = classifyThrownError(error);
      return {
        state,
        detail: isTimeoutError(error)
          ? `database health check timed out after ${context.timeoutMs}ms`
          : errorMessage(error),
        target: sanitizeTarget(context.env.DATABASE_URL as string),
        verification: "database",
      };
    }
  },
};

const redis: DependencyDefinition = {
  id: "redis",
  label: "Redis (cache, queues, rate limiting)",
  kind: "service",
  criticality: "critical",
  configKeys: ["REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "Set REDIS_URL (or REDIS_HOST/REDIS_PORT) so cache, Bull queues and distributed rate limiting have a backend.",
    unavailable:
      "Check that the Redis instance is running and reachable, then confirm REDIS_URL credentials. Transient ECONNRESET during a failover is expected and self-heals.",
    degraded:
      "Redis latency is above the configured budget. Verify the instance is not swapping or blocked by a slow command.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const configured = firstConfigured(context.env, [
      "REDIS_URL",
      "REDIS_HOST",
    ]);
    if (!configured) {
      return misconfiguredOutcome(
        "Neither REDIS_URL nor REDIS_HOST is set; Redis-backed features fall back to in-process memory",
      );
    }
    try {
      const { latencyMs } = await context.query("redis", context.timeoutMs);
      return {
        state: applyLatencyBudget(latencyMs, context.degradedLatencyMs),
        detail: `PING succeeded in ${latencyMs}ms`,
        latencyMs,
        target: sanitizeTarget(
          context.env.REDIS_URL ??
            `redis://${context.env.REDIS_HOST}:${context.env.REDIS_PORT ?? 6379}`,
        ),
        verification: "network",
      };
    } catch (error) {
      return {
        state: classifyThrownError(error),
        detail: isTimeoutError(error)
          ? `redis health check timed out after ${context.timeoutMs}ms`
          : errorMessage(error),
        target: sanitizeTarget(
          context.env.REDIS_URL ??
            `redis://${context.env.REDIS_HOST}:${context.env.REDIS_PORT ?? 6379}`,
        ),
        verification: "network",
      };
    }
  },
};

const backgroundJobs: DependencyDefinition = {
  id: "background_jobs",
  label: "Bull queues (email, webhooks, workers, notifications)",
  kind: "queue",
  criticality: "optional",
  configKeys: ["REDIS_URL", "REDIS_HOST", "REDIS_PORT"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "Bull queues require Redis. Set REDIS_URL (or REDIS_HOST/REDIS_PORT) so background jobs are processed instead of accumulating.",
    unavailable:
      "Queues share the Redis instance. Restore Redis; queued jobs resume automatically once the connection is back.",
    degraded:
      "Queue backend latency is above budget; expect delayed email, webhook and reconciliation jobs.",
    disabled: "No Redis backend configured; queues are not registered.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    if (!firstConfigured(context.env, ["REDIS_URL", "REDIS_HOST"])) {
      return disabledOutcome(
        "Queue backends are only registered when a Redis connection is configured",
      );
    }
    return {
      state: "healthy",
      detail: "Queue backends resolve to the configured Redis instance",
      verification: "configuration",
    };
  },
};

const stellarHorizon: DependencyDefinition = {
  id: "stellar_horizon",
  label: "Stellar Horizon API",
  kind: "network",
  criticality: "critical",
  configKeys: ["STELLAR_HORIZON_URL"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "Set STELLAR_HORIZON_URL to the Horizon endpoint matching the network passphrase (testnet: https://horizon-testnet.stellar.org).",
    unavailable:
      "Horizon is unreachable. Payments status lookups and reconciliation polling will fail; verify egress rules and the public Horizon URL.",
    degraded:
      "Horizon answered but is slow or erroring. Payment status reads may time out; consider lowering DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS or waiting for the public endpoint to recover.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const baseUrl = firstConfigured(context.env, ["STELLAR_HORIZON_URL"])
      ?.value;
    const target = sanitizeTarget(baseUrl ?? DEFAULT_HORIZON_URL);
    try {
      new URL(baseUrl ?? DEFAULT_HORIZON_URL);
    } catch {
      return {
        ...misconfiguredOutcome("STELLAR_HORIZON_URL is not a valid URL"),
        target,
      };
    }
    if (!context.networkProbesEnabled) {
      return {
        state: "healthy",
        detail: "URL parses; outbound probes disabled by policy",
        target,
        verification: "configuration",
      };
    }
    try {
      const outcome = await context.httpGet(target, context.timeoutMs);
      return {
        state: classifyHttpOutcome({
          status: outcome.status,
          latencyMs: outcome.latencyMs,
          degradedLatencyMs: context.degradedLatencyMs,
        }),
        detail: `HTTP ${outcome.status} in ${outcome.latencyMs}ms`,
        latencyMs: outcome.latencyMs,
        target,
        verification: "network",
      };
    } catch (error) {
      return {
        state: classifyThrownError(error),
        detail: isTimeoutError(error)
          ? `horizon health check timed out after ${context.timeoutMs}ms`
          : errorMessage(error),
        target,
        verification: "network",
      };
    }
  },
};

const stellarNetwork: DependencyDefinition = {
  id: "stellar_network_passphrase",
  label: "Stellar network passphrase",
  kind: "configuration",
  criticality: "critical",
  configKeys: ["STELLAR_NETWORK_PASSPHRASE"],
  remediation: {
    misconfigured:
      "Set STELLAR_NETWORK_PASSPHRASE to the passphrase of the network you intend to operate on (testnet: 'Test SDF Network ; September 2015'). A mismatch makes every signature invalid.",
    unavailable: "Not applicable; this dependency is configuration-only.",
    degraded: "Not applicable; this dependency is configuration-only.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const passphrase = context.env.STELLAR_NETWORK_PASSPHRASE;
    if (!isConfigured(passphrase)) {
      return misconfiguredOutcome("STELLAR_NETWORK_PASSPHRASE is not set");
    }
    const value = (passphrase as string).trim();
    if (!KNOWN_NETWORK_PASSPHRASES.includes(value)) {
      return {
        state: "degraded",
        detail:
          "STELLAR_NETWORK_PASSPHRASE does not match a known Stellar network passphrase; signatures will be rejected by the target network",
        verification: "configuration",
      };
    }
    return {
      state: "healthy",
      detail: `Passphrase matches a known network (${KNOWN_NETWORK_PASSPHRASES.indexOf(value) === 0 ? "public" : value.startsWith("Sandbox") ? "sandbox" : "testnet"})`,
      verification: "configuration",
    };
  },
};

const ethRpc: DependencyDefinition = {
  id: "eth_rpc",
  label: "EVM JSON-RPC (oracle submission)",
  kind: "network",
  criticality: "critical",
  configKeys: ["ETH_RPC_URL", "CHAIN_ID"],
  requiredConfigKeys: ["ETH_RPC_URL"],
  remediation: {
    misconfigured:
      "Set ETH_RPC_URL to the JSON-RPC endpoint of the chain you submit to, and CHAIN_ID to the decimal chain id (1 = mainnet, 11155111 = Sepolia).",
    unavailable:
      "The JSON-RPC endpoint is unreachable, so oracle payload submission and on-chain verification will fail. Confirm egress rules and provider credentials.",
    degraded:
      "The RPC endpoint answered but reported an error or is slow. Oracle submissions may be delayed or retried.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const url = context.env.ETH_RPC_URL;
    if (!isConfigured(url)) {
      return misconfiguredOutcome("ETH_RPC_URL is not set");
    }
    try {
      new URL(url as string);
    } catch {
      return {
        ...misconfiguredOutcome("ETH_RPC_URL is not a valid URL"),
        target: sanitizeTarget(url as string),
      };
    }
    const target = sanitizeTarget(url as string);
    if (!context.networkProbesEnabled) {
      return {
        state: "healthy",
        detail: "URL parses; outbound probes disabled by policy",
        target,
        verification: "configuration",
      };
    }
    try {
      const outcome = await context.jsonRpc(target, "eth_chainId", context.timeoutMs);
      if (outcome.error) {
        return {
          state: "misconfigured",
          detail: `JSON-RPC error: ${outcome.error}`,
          latencyMs: outcome.latencyMs,
          target,
          verification: "network",
        };
      }
      const chainId = normalizeChainId(outcome.result);
      if (chainId === undefined) {
        return {
          state: "degraded",
          detail: "eth_chainId returned an unexpected value",
          latencyMs: outcome.latencyMs,
          target,
          verification: "network",
        };
      }
      const expected = normalizeChainId(context.env.CHAIN_ID);
      if (expected !== undefined && expected !== chainId) {
        return {
          state: "degraded",
          detail: `Network assumption mismatch: CHAIN_ID=${expected} but the endpoint reports chainId=${chainId}`,
          latencyMs: outcome.latencyMs,
          target,
          verification: "network",
        };
      }
      return {
        state: applyLatencyBudget(
          outcome.latencyMs,
          context.degradedLatencyMs,
        ),
        detail: `eth_chainId=${chainId} in ${outcome.latencyMs}ms`,
        latencyMs: outcome.latencyMs,
        target,
        verification: "network",
      };
    } catch (error) {
      return {
        state: classifyThrownError(error),
        detail: isTimeoutError(error)
          ? `json-rpc health check timed out after ${context.timeoutMs}ms`
          : errorMessage(error),
        target,
        verification: "network",
      };
    }
  },
};

const objectStorage: DependencyDefinition = {
  id: "object_storage",
  label: "File object storage",
  kind: "storage",
  criticality: "optional",
  configKeys: [
    "FILE_STORAGE_BACKEND",
    "FILE_STORAGE_LOCAL_PATH",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_STORAGE_CONTAINER",
  ],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "Complete the configuration for the backend named by FILE_STORAGE_BACKEND. With backend=local, set FILE_STORAGE_LOCAL_PATH; with s3, set S3_BUCKET and S3_REGION; with azure_blob, set AZURE_STORAGE_CONNECTION_STRING and AZURE_STORAGE_CONTAINER.",
    unavailable:
      "The configured storage backend is not reachable. File uploads will fail; verify the endpoint host and credentials.",
    degraded:
      "Object storage answered but is slow or erroring. Uploads may be retried by clients.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const backend = (context.env.FILE_STORAGE_BACKEND ?? "local").toLowerCase();
    if (backend === "local") {
      return {
        state: "healthy",
        detail: "FILE_STORAGE_BACKEND=local; no external storage service is required",
        target: context.env.FILE_STORAGE_LOCAL_PATH ?? "./uploads",
        verification: "configuration",
      };
    }
    if (backend === "s3") {
      if (!isConfigured(context.env.S3_BUCKET) || !isConfigured(context.env.S3_REGION)) {
        return misconfiguredOutcome(
          "FILE_STORAGE_BACKEND=s3 requires S3_BUCKET and S3_REGION",
        );
      }
      const host = context.env.S3_ENDPOINT
        ? resolveHostPort(context.env.S3_ENDPOINT, 443).host
        : `s3.${context.env.S3_REGION}.amazonaws.com`;
      const endpoint = isConfigured(context.env.S3_ENDPOINT)
        ? (context.env.S3_ENDPOINT as string)
        : `https://${host}`;
      if (!context.networkProbesEnabled) {
        return {
          state: "healthy",
          detail: "S3 configuration complete; outbound probes disabled by policy",
          target: sanitizeTarget(endpoint),
          verification: "configuration",
        };
      }
      try {
        const outcome = await context.httpGet(
          sanitizeTarget(endpoint),
          context.timeoutMs,
        );
        return {
          state: classifyHttpOutcome({
            status: outcome.status,
            latencyMs: outcome.latencyMs,
            degradedLatencyMs: context.degradedLatencyMs,
          }),
          detail: `HTTP ${outcome.status} in ${outcome.latencyMs}ms`,
          latencyMs: outcome.latencyMs,
          target: sanitizeTarget(endpoint),
          verification: "network",
        };
      } catch (error) {
        return {
          state: classifyThrownError(error),
          detail: errorMessage(error),
          target: sanitizeTarget(endpoint),
          verification: "network",
        };
      }
    }
    if (backend === "azure_blob") {
      if (!isConfigured(context.env.AZURE_STORAGE_CONNECTION_STRING)) {
        return misconfiguredOutcome(
          "FILE_STORAGE_BACKEND=azure_blob requires AZURE_STORAGE_CONNECTION_STRING",
        );
      }
      return {
        state: "healthy",
        detail:
          "Azure Blob connection string present (not contacted to avoid leaking the shared key in request logs)",
        target: "blob.core.windows.net:443",
        verification: "configuration",
      };
    }
    return misconfiguredOutcome(
      `FILE_STORAGE_BACKEND=${backend} is not one of: local, s3, azure_blob`,
    );
  },
};

const smtp: DependencyDefinition = {
  id: "smtp",
  label: "SMTP relay (verification and notification email)",
  kind: "network",
  criticality: "optional",
  configKeys: ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "Set SMTP_HOST (and SMTP_PORT when not 587) to the relay Trellis should send through. Note that the SMTP provider reads SMTP_PASS for the password while the rest of the configuration uses SMTP_PASSWORD.",
    unavailable:
      "The SMTP relay is not reachable, so verification and notification emails will queue instead of sending.",
    degraded: "SMTP connected but slowly; expect delayed email delivery.",
    disabled: "No SMTP relay configured; email is not attempted.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const host = context.env.SMTP_HOST;
    if (!isConfigured(host)) {
      return disabledOutcome("SMTP_HOST is not set");
    }
    const port = Number(context.env.SMTP_PORT ?? 587);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return misconfiguredOutcome(
        `SMTP_PORT=${context.env.SMTP_PORT} is not a valid port`,
      );
    }
    const target = `${host}:${port}`;
    if (!context.networkProbesEnabled) {
      return {
        state: "healthy",
        detail: "SMTP relay configured; outbound probes disabled by policy",
        target,
        verification: "configuration",
      };
    }
    try {
      const latencyMs = await context.tcpConnect(host, port, context.timeoutMs);
      return {
        state: applyLatencyBudget(latencyMs, context.degradedLatencyMs),
        detail: `TCP connect in ${latencyMs}ms`,
        latencyMs,
        target,
        verification: "network",
      };
    } catch (error) {
      return {
        state: classifyThrownError(error),
        detail: isTimeoutError(error)
          ? `smtp connect timed out after ${context.timeoutMs}ms`
          : errorMessage(error),
        target,
        verification: "network",
      };
    }
  },
};

const elasticsearch: DependencyDefinition = {
  id: "elasticsearch",
  label: "Elasticsearch (search and ELK log shipping)",
  kind: "service",
  criticality: "optional",
  configKeys: ["ELASTICSEARCH_URL", "ELASTICSEARCH_INDEX_PREFIX"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured: "Set ELASTICSEARCH_URL to the cluster URL (default http://localhost:9200).",
    unavailable:
      "Elasticsearch is unreachable. Search endpoints and ELK log shipping are degraded but the rest of the API keeps working.",
    degraded:
      "Elasticsearch answered slowly. Search results may be served from a stale index.",
    disabled:
      "Set ELASTICSEARCH_URL to the cluster URL so the address is declared in configuration instead of compiled in, and so it can be probed.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const configured = firstConfigured(context.env, ["ELASTICSEARCH_URL"]);
    if (!configured) {
      // Never reach out to a compiled-in default: an unset optional dependency
      // is a configuration choice, and probing it would hide the assumption.
      return {
        state: "disabled",
        detail:
          "ELASTICSEARCH_URL is not set; SearchModule uses its compiled-in default node, which is not probed",
        target: sanitizeTarget(DEFAULT_ELASTICSEARCH_URL),
        verification: "configuration",
      };
    }
    const target = sanitizeTarget(configured.value);
    if (!context.networkProbesEnabled) {
      return {
        state: "healthy",
        detail: "ELASTICSEARCH_URL configured; outbound probes disabled by policy",
        target,
        verification: "configuration",
      };
    }
    try {
      const outcome = await context.httpGet(target, context.timeoutMs);
      return {
        state: classifyHttpOutcome({
          status: outcome.status,
          latencyMs: outcome.latencyMs,
          degradedLatencyMs: context.degradedLatencyMs,
        }),
        detail: `HTTP ${outcome.status} in ${outcome.latencyMs}ms`,
        latencyMs: outcome.latencyMs,
        target,
        verification: "network",
      };
    } catch (error) {
      return {
        state: classifyThrownError(error),
        detail: errorMessage(error),
        target,
        verification: "network",
      };
    }
  },
};

const otelCollector: DependencyDefinition = {
  id: "otel_collector",
  label: "OpenTelemetry collector (tracing export)",
  kind: "network",
  criticality: "optional",
  configKeys: ["OTEL_EXPORTER_OTLP_ENDPOINT", "TRACING_ENABLED"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute URL when tracing is enabled. Traces are dropped silently otherwise.",
    unavailable:
      "The collector is unreachable. Spans are buffered and dropped; the API itself is unaffected.",
    degraded: "The collector accepted the connection but is slow; spans may be dropped.",
    disabled: "TRACING_ENABLED=false; no collector required.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    if (String(context.env.TRACING_ENABLED ?? "true").toLowerCase() === "false") {
      return disabledOutcome("TRACING_ENABLED=false");
    }
    const endpoint = context.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!isConfigured(endpoint)) {
      return disabledOutcome("OTEL_EXPORTER_OTLP_ENDPOINT is not set");
    }
    const { host, port } = resolveHostPort(endpoint as string, 4318);
    if (!context.networkProbesEnabled) {
      return {
        state: "healthy",
        detail: "OTLP endpoint configured; outbound probes disabled by policy",
        target: `${host}:${port}`,
        verification: "configuration",
      };
    }
    try {
      const latencyMs = await context.tcpConnect(host, port, context.timeoutMs);
      return {
        state: applyLatencyBudget(latencyMs, context.degradedLatencyMs),
        detail: `TCP connect in ${latencyMs}ms`,
        latencyMs,
        target: `${host}:${port}`,
        verification: "network",
      };
    } catch (error) {
      return {
        state: classifyThrownError(error),
        detail: errorMessage(error),
        target: `${host}:${port}`,
        verification: "network",
      };
    }
  },
};

const sentryDsn: DependencyDefinition = {
  id: "sentry",
  label: "Sentry error reporting",
  kind: "configuration",
  criticality: "optional",
  configKeys: ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_RELEASE"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "SENTRY_DSN is present but is not a valid DSN. Error reporting stays disabled until it is fixed.",
    unavailable: "Not applicable; this dependency is configuration-only.",
    degraded: "Not applicable; this dependency is configuration-only.",
    disabled: "SENTRY_DSN is not set; error reporting is disabled.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    const dsn = context.env.SENTRY_DSN;
    if (!isConfigured(dsn)) {
      return disabledOutcome("SENTRY_DSN is not set");
    }
    try {
      const parsed = new URL(dsn as string);
      if (!parsed.protocol.startsWith("http") || !parsed.pathname.includes("/")) {
        throw new Error("missing project path");
      }
    } catch {
      return misconfiguredOutcome("SENTRY_DSN is not a valid Sentry DSN");
    }
    return {
      state: "healthy",
      detail: `DSN parsed for host ${new URL(dsn as string).host}`,
      verification: "configuration",
    };
  },
};

const aiProvider: DependencyDefinition = {
  id: "ai_provider",
  label: "AI compute provider (OpenAI compatible)",
  kind: "configuration",
  criticality: "optional",
  configKeys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  requiredConfigKeys: [],
  remediation: {
    misconfigured:
      "Set OPENAI_API_KEY together with OPENAI_BASE_URL when using a non-default OpenAI-compatible endpoint, so compute jobs fail fast with an actionable error instead of timing out.",
    unavailable: "Not applicable; this dependency is configuration-only.",
    degraded: "Not applicable; this dependency is configuration-only.",
    disabled: "No AI provider credentials configured; compute bridge stays offline.",
  },
  async probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome> {
    if (!isConfigured(context.env.OPENAI_API_KEY)) {
      return disabledOutcome("OPENAI_API_KEY is not set");
    }
    const baseUrl = context.env.OPENAI_BASE_URL;
    if (isConfigured(baseUrl)) {
      try {
        new URL(baseUrl as string);
      } catch {
        return misconfiguredOutcome("OPENAI_BASE_URL is not a valid URL");
      }
    }
    return {
      state: "healthy",
      detail: isConfigured(baseUrl)
        ? "API key and base URL present (not contacted to avoid billing a health check)"
        : "API key present (not contacted to avoid billing a health check)",
      target: isConfigured(baseUrl)
        ? sanitizeTarget(baseUrl as string)
        : "https://api.openai.com/v1",
      verification: "configuration",
    };
  },
};

/** Ordered registry. The order is the order used by every rendered report. */
export const DEPENDENCY_DEFINITIONS: DependencyDefinition[] = [
  database,
  redis,
  backgroundJobs,
  stellarHorizon,
  stellarNetwork,
  ethRpc,
  objectStorage,
  smtp,
  elasticsearch,
  otelCollector,
  sentryDsn,
  aiProvider,
];

export function findDependencyDefinition(
  id: string,
): DependencyDefinition | undefined {
  return DEPENDENCY_DEFINITIONS.find((definition) => definition.id === id);
}

/** Accepts both `1` and `0x1`/`0x01` hex forms, as different RPCs report them. */
function normalizeChainId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^0x/i.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 16);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
