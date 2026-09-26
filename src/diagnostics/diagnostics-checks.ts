/**
 * Testable core logic for the contributor diagnostics command.
 *
 * All I/O (filesystem reads, TCP probes, process.env) is injected so unit
 * tests can run without real connections.
 *
 * Issue: #67
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface DiagnosticCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Environment variable check
// ──────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [/your[-_]?/i, /placeholder/i, /changeme/i];

interface EnvVarSpec {
  key: string;
  required: boolean;
  hint: string;
  remediation: string;
}

export const REQUIRED_ENV_SPECS: EnvVarSpec[] = [
  {
    key: "DATABASE_URL",
    required: true,
    hint: "PostgreSQL connection string",
    remediation:
      "Set DATABASE_URL=postgresql://user:password@localhost:5432/trellis_dev in your .env",
  },
  {
    key: "JWT_SECRET",
    required: true,
    hint: "JWT signing secret (32+ char random string)",
    remediation:
      "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  },
  {
    key: "REDIS_URL",
    required: false,
    hint: "Redis connection URL (rate limiting, caching, queues)",
    remediation: "Add REDIS_URL=redis://localhost:6379 to .env",
  },
];

export function checkEnvVars(
  env: Record<string, string | undefined>,
  specs: EnvVarSpec[] = REQUIRED_ENV_SPECS,
): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];

  for (const spec of specs) {
    const value = env[spec.key];
    if (!value || value.trim() === "") {
      checks.push({
        name: `env:${spec.key}`,
        status: spec.required ? "fail" : "warn",
        detail: `${spec.key} (${spec.hint}) is not set`,
        remediation: spec.remediation,
      });
    } else if (PLACEHOLDER_PATTERNS.some((p) => p.test(value))) {
      checks.push({
        name: `env:${spec.key}`,
        status: "warn",
        detail: `${spec.key} appears to be a placeholder value`,
        remediation: `Replace the placeholder in your .env with a real value.`,
      });
    } else {
      checks.push({
        name: `env:${spec.key}`,
        status: "pass",
        detail: `${spec.key} is set`,
      });
    }
  }

  return checks;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool version check
// ──────────────────────────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  version: string | null;
  minMajor?: number;
  required: boolean;
  remediation: string;
}

export function checkToolVersion(spec: ToolSpec): DiagnosticCheck {
  if (!spec.version) {
    return {
      name: `tool:${spec.name}`,
      status: spec.required ? "fail" : "warn",
      detail: `${spec.name} not found`,
      remediation: spec.remediation,
    };
  }

  if (spec.minMajor) {
    const raw = spec.version.replace(/^v/, "").split(".")[0];
    const major = parseInt(raw, 10);
    if (Number.isFinite(major) && major < spec.minMajor) {
      return {
        name: `tool:${spec.name}`,
        status: "fail",
        detail: `${spec.name} ${spec.version} is below minimum major version ${spec.minMajor}`,
        remediation: spec.remediation,
      };
    }
  }

  return {
    name: `tool:${spec.name}`,
    status: "pass",
    detail: `${spec.name} ${spec.version}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TCP connectivity check (logic only — caller provides probe fn)
// ──────────────────────────────────────────────────────────────────────────────

export async function checkTcpConnectivity(
  label: string,
  host: string,
  port: number,
  probe: (host: string, port: number) => Promise<boolean>,
  remediation: string,
): Promise<DiagnosticCheck> {
  const reachable = await probe(host, port);
  return reachable
    ? { name: label, status: "pass", detail: `Reachable at ${host}:${port}` }
    : { name: label, status: "fail", detail: `Cannot reach ${host}:${port}`, remediation };
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP endpoint check (logic only)
// ──────────────────────────────────────────────────────────────────────────────

export async function checkHttpEndpoint(
  label: string,
  url: string,
  probe: (url: string) => Promise<{ ok: boolean; status?: number }>,
  remediation: string,
): Promise<DiagnosticCheck> {
  const result = await probe(url);
  if (result.ok && result.status && result.status < 500) {
    return {
      name: label,
      status: "pass",
      detail: `${url} responded with HTTP ${result.status}`,
    };
  }
  return {
    name: label,
    status: "warn",
    detail: `${url} unreachable or returned error`,
    remediation,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report aggregation
// ──────────────────────────────────────────────────────────────────────────────

export interface DiagnosticsReport {
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  checks: DiagnosticCheck[];
  ok: boolean;
}

export function buildReport(checks: DiagnosticCheck[]): DiagnosticsReport {
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let skipped = 0;

  for (const c of checks) {
    if (c.status === "pass") passed++;
    else if (c.status === "fail") failed++;
    else if (c.status === "warn") warned++;
    else skipped++;
  }

  return { passed, failed, warned, skipped, checks, ok: failed === 0 };
}
