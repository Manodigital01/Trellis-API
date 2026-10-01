/**
 * Pure helpers shared by the dependency health module, the maintainer CLI and
 * the unit tests: secret redaction, state classification and report
 * aggregation. No I/O happens in this file.
 *
 * Issue: #124
 */

import {
  DEPENDENCY_STATE_SEVERITY,
  DependencyCheckResult,
  DependencyDefinition,
  DependencyProbeContext,
  DependencyProbeOutcome,
  DependencyReport,
  DependencyState,
  DependencyStateCounts,
} from "./dependency-health.types";

export const REDACTED = "***REDACTED***";

/** Environment variable names whose *values* must never reach any output. */
export const SECRET_ENV_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|CREDENTIAL|SESSION_KEY|ENCRYPTION_KEY|DSN|SIGNING_KEY|WEBHOOK_URL)/i;

/** Placeholder values that indicate a copied-from-example secret. */
export const PLACEHOLDER_VALUE_PATTERNS: RegExp[] = [
  /^your[-_ ]?/i,
  /^placeholder$/i,
  /^changeme/i,
  /^example/i,
  /^<.*>$/,
  /^sk-your-/i,
];

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const KEY_VALUE_SECRET =
  /([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_?KEY|ACCESS_KEY|CREDENTIAL|SESSION_KEY|ENCRYPTION_KEY|DSN)[A-Za-z0-9_.-]*)("?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;
const OPaque_TOKEN = /\b[A-Za-z0-9_+/=-]{40,}\b/g;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
const MAX_DETAIL_LENGTH = 300;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_PATTERN.test(key);
}

export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return PLACEHOLDER_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Removes every known secret value from a string. Called with the values of all
 * secret-shaped environment variables so that a driver error which echoes a
 * connection string can never leak credentials.
 */
export function redactSecretValues(
  input: string,
  secretValues: Array<string | undefined>,
): string {
  let output = input;
  for (const value of secretValues) {
    if (!value || value.length < 6) continue;
    output = output.split(value).join(REDACTED);
  }
  return output;
}

/** Strips credentials and long opaque tokens from an arbitrary message. */
export function scrubMessage(input: string): string {
  let output = String(input ?? "")
    .replace(PEM_BLOCK, REDACTED)
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(
      KEY_VALUE_SECRET,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
    )
    .replace(OPaque_TOKEN, REDACTED)
    .replace(/\s+/g, " ")
    .trim();
  if (output.length > MAX_DETAIL_LENGTH) {
    output = `${output.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
  }
  return output;
}

/**
 * Full sanitisation pipeline applied to every probe message before it is
 * returned to a caller: redact known secret values, then scrub structural
 * secret patterns, then normalise whitespace and length.
 */
export function sanitizeDependencyMessage(
  input: string,
  env: Record<string, string | undefined> = {},
): string {
  const secretValues = Object.entries(env)
    .filter(([key, value]) => isSecretEnvKey(key) && isConfigured(value))
    .map(([, value]) => value);
  const redacted = redactSecretValues(String(input ?? ""), secretValues);
  return scrubMessage(redacted).replace(CONTROL_CHARS, "");
}

/** Returns a URL safe to display: credentials removed, query string dropped. */
export function sanitizeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return scrubMessage(url);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const TIMEOUT_PATTERN = /timed? ?out|timeout|etimedout|esockettimedout/i;
const NETWORK_PATTERN =
  /econnrefused|econnreset|enotfound|ehostunreach|enetunreach|eai_again|socket hang up|network error|fetch failed|connection refused|connection closed|unavailable/i;
const AUTH_PATTERN =
  /password authentication|authentication failed|permission denied|access denied|unauthorized|invalid credentials|token signature|signature mismatch/i;
const CONFIG_PATTERN =
  /invalid (url|configuration|option)|malformed|unsupported protocol|must be a|is required|missing/i;

/**
 * Maps a thrown transport/driver error onto a dependency state.
 *
 * `misconfigured` is reserved for problems that will not change by retrying
 * (bad credentials, unparseable endpoints). Everything else is `unavailable`.
 */
export function classifyThrownError(error: unknown): DependencyState {
  const message = errorMessage(error);
  if (AUTH_PATTERN.test(message)) return "misconfigured";
  if (CONFIG_PATTERN.test(message)) return "misconfigured";
  if (TIMEOUT_PATTERN.test(message) || NETWORK_PATTERN.test(message)) {
    return "unavailable";
  }
  return "unavailable";
}

/** True when the failure was a timeout rather than an immediate rejection. */
export function isTimeoutError(error: unknown): boolean {
  return TIMEOUT_PATTERN.test(errorMessage(error));
}

export interface HttpClassificationInput {
  status: number;
  latencyMs: number;
  degradedLatencyMs: number;
}

/**
 * HTTP outcomes: 2xx/3xx is healthy, 429 and 5xx are degraded (the dependency
 * answered but is not serving us properly), other 4xx are degraded as well
 * because reachability is proven but the request is being rejected.
 */
export function classifyHttpOutcome(
  input: HttpClassificationInput,
): DependencyState {
  if (input.status >= 200 && input.status < 400) {
    return input.latencyMs > input.degradedLatencyMs ? "degraded" : "healthy";
  }
  if (input.status === 429) return "degraded";
  return "degraded";
}

/** Applies the latency ceiling to an already-successful probe. */
export function applyLatencyBudget(
  latencyMs: number,
  degradedLatencyMs: number,
): DependencyState {
  return latencyMs > degradedLatencyMs ? "degraded" : "healthy";
}

/** Finds the first configured value among a list of environment keys. */
export function firstConfigured(
  env: Record<string, string | undefined>,
  keys: string[],
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = env[key];
    if (isConfigured(value)) return { key, value: value as string };
  }
  return undefined;
}

/** Splits `host:port` / full URL into host and port for TCP probes. */
export function resolveHostPort(
  value: string,
  defaultPort: number,
): { host: string; port: number } {
  const candidate = value.includes("://") ? value : `tcp://${value}`;
  try {
    const parsed = new URL(candidate);
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    return { host: parsed.hostname, port };
  } catch {
    return { host: value, port: defaultPort };
  }
}

export interface ConfigKeyReportInput {
  key: string;
  configured: boolean;
}

export function buildConfigKeyReports(
  context: DependencyProbeContext,
  keys: string[],
  extraKeys: string[] = [],
): ConfigKeyReportInput[] {
  const all = Array.from(new Set([...keys, ...extraKeys]));
  return all.map((key) => ({ key, configured: isConfigured(context.env[key]) }));
}

export function misconfiguredOutcome(
  detail: string,
  extraConfigKeys: string[] = [],
): DependencyProbeOutcome {
  return {
    state: "misconfigured",
    detail,
    verification: "configuration",
    extraConfigKeys,
  };
}

export function disabledOutcome(
  detail: string,
  extraConfigKeys: string[] = [],
): DependencyProbeOutcome {
  return {
    state: "disabled",
    detail,
    verification: "not-applicable",
    extraConfigKeys,
  };
}

export function pickRemediation(
  definition: DependencyDefinition,
  state: DependencyState,
): string {
  switch (state) {
    case "misconfigured":
      return definition.remediation.misconfigured;
    case "unavailable":
      return definition.remediation.unavailable;
    case "degraded":
      return definition.remediation.degraded;
    case "disabled":
      return definition.remediation.disabled ?? "";
    default:
      return "";
  }
}

/**
 * `disabled` means "not in use here", so it must never make a report look
 * unhealthy; it is still listed in the per-dependency findings.
 */
function rollupState(states: DependencyState[]): DependencyState {
  return worstState(
    states.map((state) => (state === "disabled" ? "healthy" : state)),
  );
}

export function worstState(states: DependencyState[]): DependencyState {
  let worst: DependencyState = "healthy";
  for (const state of states) {
    if (DEPENDENCY_STATE_SEVERITY[state] > DEPENDENCY_STATE_SEVERITY[worst]) {
      worst = state;
    }
  }
  return worst;
}

function emptyCounts(): DependencyStateCounts {
  return {
    healthy: 0,
    degraded: 0,
    unavailable: 0,
    misconfigured: 0,
    disabled: 0,
  };
}

/** Aggregates individual results into a report. Critical state gates the report. */
export function buildDependencyReport(
  checks: DependencyCheckResult[],
  durationMs: number,
  networkProbesSkipped: boolean,
  generatedAt: string,
): DependencyReport {
  const counts = emptyCounts();
  for (const check of checks) counts[check.state] += 1;

  const critical = checks.filter((c) => c.criticality === "critical");
  const optional = checks.filter((c) => c.criticality === "optional");

  const bySeverity = (a: DependencyCheckResult, b: DependencyCheckResult) =>
    DEPENDENCY_STATE_SEVERITY[b.state] - DEPENDENCY_STATE_SEVERITY[a.state] ||
    a.id.localeCompare(b.id);

  return {
    status: rollupState(critical.map((c) => c.state)),
    advisory: rollupState(optional.map((c) => c.state)),
    generatedAt,
    durationMs,
    counts,
    criticalFindings: critical
      .filter((c) => c.state !== "healthy" && c.state !== "disabled")
      .sort(bySeverity)
      .map((c) => c.id),
    advisoryFindings: optional
      .filter((c) => c.state !== "healthy" && c.state !== "disabled")
      .sort(bySeverity)
      .map((c) => c.id),
    checks,
    networkProbesSkipped,
  };
}

/**
 * Invariant enforced by `runDependencyChecks`: a dependency may never be
 * reported as `healthy` while one of its required configuration keys is
 * missing, and a `critical` dependency is never reported as `disabled`.
 */
export function isStateAllowedForConfig(
  state: DependencyState,
  criticality: DependencyDefinition["criticality"],
  requiredConfigKeys: ConfigKeyReportInput[],
): boolean {
  if (state === "healthy" && requiredConfigKeys.some((k) => !k.configured)) {
    return false;
  }
  if (state === "disabled" && criticality === "critical") return false;
  return true;
}

/** Extracts the presence of the strictly required keys of a definition. */
export function requiredConfigKeyReports(
  definition: DependencyDefinition,
  result: DependencyCheckResult,
): ConfigKeyReportInput[] {
  const required = definition.requiredConfigKeys ?? definition.configKeys;
  return required.map((key) => ({
    key,
    configured: result.configKeys.find((c) => c.key === key)?.configured === true,
  }));
}

export function assertDependencyStates(
  results: Array<{
    definition: DependencyDefinition;
    result: DependencyCheckResult;
  }>,
): void {
  const violations = results
    .filter(
      ({ definition, result }) =>
        !isStateAllowedForConfig(
          result.state,
          definition.criticality,
          requiredConfigKeyReports(definition, result),
        ),
    )
    .map(
      ({ definition, result }) =>
        `${definition.id}: state "${result.state}" is inconsistent with its configuration`,
    );

  if (violations.length > 0) {
    throw new Error(
      `Dependency health invariant violated: ${violations.join("; ")}`,
    );
  }
}
