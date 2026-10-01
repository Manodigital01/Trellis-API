/**
 * Shared types for the external dependency health check.
 *
 * The module is deliberately dependency-free: every probe receives a
 * {@link DependencyProbeContext} that owns the I/O. That lets the exact same
 * probe definitions run inside the Nest application
 * (`DependencyHealthService`), inside the maintainer CLI
 * (`scripts/dependency-health.ts`) and inside unit tests with a fake context —
 * without ever touching a production service.
 *
 * Issue: #124
 */

/**
 * Health of a single external dependency.
 *
 * - `healthy`      — reachable and behaving as assumed.
 * - `degraded`     — reachable, but slower than expected or partially failing.
 * - `unavailable`  — the dependency cannot be reached at all.
 * - `misconfigured`— the dependency cannot be attempted because required
 *                    configuration is missing or unusable.
 * - `disabled`     — intentionally not wired up (feature flag off / no config
 *                    and no code default that would make the check meaningful).
 */
export type DependencyState =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "misconfigured"
  | "disabled";

/** Severity ordering helper. `disabled` never contributes to the overall status. */
export const DEPENDENCY_STATE_SEVERITY: Record<DependencyState, number> = {
  healthy: 0,
  disabled: 0,
  degraded: 1,
  unavailable: 2,
  misconfigured: 3,
};

export type DependencyKind =
  | "service"
  | "network"
  | "configuration"
  | "storage"
  | "queue";

/**
 * `critical` dependencies gate the readiness of the API: when one of them is
 * `unavailable` or `misconfigured` the service must not serve traffic.
 * `optional` dependencies only produce advisory findings.
 */
export type DependencyCriticality = "critical" | "optional";

/** How a state was established, so maintainers can tell a real probe from config inspection. */
export type DependencyVerification =
  | "network"
  | "database"
  | "configuration"
  | "not-applicable";

export interface DependencyConfigKeyReport {
  key: string;
  /** Whether the variable holds a non-empty value. The value is never returned. */
  configured: boolean;
}

/** Raw HTTP result handed back to a probe by the context. */
export interface HttpProbeOutcome {
  status: number;
  latencyMs: number;
}

/** Raw JSON-RPC result handed back to a probe by the context. */
export interface JsonRpcProbeOutcome {
  latencyMs: number;
  result?: unknown;
  error?: string;
}

/** I/O primitives a probe is allowed to use. */
export interface DependencyProbeContext {
  /** Environment snapshot. Secrets are read from here but never emitted. */
  env: Record<string, string | undefined>;
  /** Per-probe timeout in milliseconds. */
  timeoutMs: number;
  /** Latency above this value downgrades an otherwise healthy dependency. */
  degradedLatencyMs: number;
  /** Monotonic-ish clock so tests can make latency deterministic. */
  now(): number;
  /** `true` when outbound third-party probes are permitted. */
  networkProbesEnabled: boolean;
  httpGet(url: string, timeoutMs: number): Promise<HttpProbeOutcome>;
  jsonRpc(
    url: string,
    method: string,
    timeoutMs: number,
  ): Promise<JsonRpcProbeOutcome>;
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<number>;
  /**
   * Executes a trivial round trip against a backing store.
   * `postgres` runs `SELECT 1`; `redis` runs `PING`.
   */
  query(
    system: "postgres" | "redis",
    timeoutMs: number,
  ): Promise<{ latencyMs: number }>;
}

/** What a probe reports back. Detail strings are sanitized before they are surfaced. */
export interface DependencyProbeOutcome {
  state: DependencyState;
  detail: string;
  latencyMs?: number;
  /** Sanitized target (host/URL with credentials stripped). */
  target?: string;
  verification?: DependencyVerification;
  /** Extra configuration keys that gate this dependency beyond `configKeys`. */
  extraConfigKeys?: string[];
}

export interface DependencyRemediation {
  misconfigured: string;
  unavailable: string;
  degraded: string;
  disabled?: string;
}

export interface DependencyDefinition {
  id: string;
  label: string;
  kind: DependencyKind;
  criticality: DependencyCriticality;
  /**
   * Environment variable names this dependency reads. Names only — the values
   * are never part of a report. Reported verbatim in the diagnostics output.
   */
  configKeys: string[];
  /**
   * Subset of `configKeys` that must be present for a `healthy` verdict.
   * Defaults to `configKeys`. Keys omitted here have a code-level default, so
   * a missing value is still a working configuration.
   */
  requiredConfigKeys?: string[];
  remediation: DependencyRemediation;
  probe(context: DependencyProbeContext): Promise<DependencyProbeOutcome>;
}

export interface DependencyCheckResult {
  id: string;
  label: string;
  kind: DependencyKind;
  criticality: DependencyCriticality;
  state: DependencyState;
  /** Sanitized, human readable explanation. Never contains secret values. */
  detail: string;
  latencyMs?: number;
  target?: string;
  verification: DependencyVerification;
  configKeys: DependencyConfigKeyReport[];
  /** Actionable next step for the reported state. */
  remediation: string;
}

export interface DependencyStateCounts {
  healthy: number;
  degraded: number;
  unavailable: number;
  misconfigured: number;
  disabled: number;
}

export interface DependencyReport {
  status: DependencyState;
  /** Worst state across optional dependencies. Informational only. */
  advisory: DependencyState;
  generatedAt: string;
  durationMs: number;
  counts: DependencyStateCounts;
  /** Ids of critical dependencies that are not healthy, worst first. */
  criticalFindings: string[];
  /** Ids of optional dependencies that are not healthy, worst first. */
  advisoryFindings: string[];
  checks: DependencyCheckResult[];
  /** True when at least one outbound network probe was skipped by policy. */
  networkProbesSkipped: boolean;
}
