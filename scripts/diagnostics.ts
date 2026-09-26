#!/usr/bin/env ts-node
/**
 * Trellis API — Contributor Diagnostics
 * ──────────────────────────────────────
 * Run before starting local development to verify your environment is fully
 * configured.  Produces a pass/fail report with actionable remediation steps.
 *
 * Usage:
 *   npm run diagnostics          — full check
 *   npm run diagnostics -- --quick   — skip slow network checks
 *
 * This script NEVER mutates any data.  All checks are read-only.
 *
 * Issue: #67
 */

import "dotenv/config";
import { execSync, spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import * as http from "http";
import * as https from "https";

// ──────────────────────────────────────────────────────────────────────────────
// Colour helpers (no deps — use raw ANSI so the script runs before npm install)
// ──────────────────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

type Status = "pass" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  remediation?: string;
}

const results: CheckResult[] = [];

function pass(name: string, detail: string): CheckResult {
  const r: CheckResult = { name, status: "pass", detail };
  results.push(r);
  return r;
}

function fail(name: string, detail: string, remediation: string): CheckResult {
  const r: CheckResult = { name, status: "fail", detail, remediation };
  results.push(r);
  return r;
}

function warn(name: string, detail: string, remediation?: string): CheckResult {
  const r: CheckResult = { name, status: "warn", detail, remediation };
  results.push(r);
  return r;
}

function skip(name: string, detail: string): CheckResult {
  const r: CheckResult = { name, status: "skip", detail };
  results.push(r);
  return r;
}

function statusIcon(s: Status): string {
  switch (s) {
    case "pass": return c.green("✓");
    case "fail": return c.red("✗");
    case "warn": return c.yellow("⚠");
    case "skip": return c.dim("–");
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: probe TCP connectivity
// ──────────────────────────────────────────────────────────────────────────────
function probeTcp(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: probe HTTP/HTTPS endpoint
// ──────────────────────────────────────────────────────────────────────────────
function probeHttp(url: string, timeoutMs = 5000): Promise<{ ok: boolean; status?: number }> {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume(); // drain
      resolve({ ok: true, status: res.statusCode });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: run a command and return its trimmed stdout (or null on failure)
// ──────────────────────────────────────────────────────────────────────────────
function runCmd(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ──────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const ROOT = path.resolve(__dirname, "..");

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 1: Required tools
// ──────────────────────────────────────────────────────────────────────────────
async function checkTools(): Promise<void> {
  console.log(c.bold("\n── Required tools ──────────────────────────────────────────────"));

  const tools: Array<{ cmd: string; versionFlag: string; minVersion?: string; remediation: string }> = [
    {
      cmd: "node",
      versionFlag: "--version",
      minVersion: "18.0.0",
      remediation: "Install Node.js 18+ from https://nodejs.org or use nvm: nvm install 18",
    },
    {
      cmd: "npm",
      versionFlag: "--version",
      remediation: "npm ships with Node.js. Update via: npm install -g npm@latest",
    },
    {
      cmd: "git",
      versionFlag: "--version",
      remediation: "Install Git from https://git-scm.com",
    },
    {
      cmd: "docker",
      versionFlag: "--version",
      remediation: "Install Docker Desktop from https://docker.com/get-started (optional but recommended for DB / Redis).",
    },
    {
      cmd: "psql",
      versionFlag: "--version",
      remediation: "Install PostgreSQL client: brew install postgresql | apt install postgresql-client | https://postgresql.org",
    },
  ];

  for (const tool of tools) {
    const out = runCmd(`${tool.cmd} ${tool.versionFlag}`);
    if (!out) {
      // docker and psql are optional
      if (["docker", "psql"].includes(tool.cmd)) {
        warn(`tool:${tool.cmd}`, `${tool.cmd} not found (optional)`, tool.remediation);
      } else {
        fail(`tool:${tool.cmd}`, `${tool.cmd} not found`, tool.remediation);
      }
      continue;
    }

    // Check minimum version for Node
    if (tool.cmd === "node" && tool.minVersion) {
      const raw = out.replace(/^v/, "");
      const major = parseInt(raw.split(".")[0], 10);
      if (major < parseInt(tool.minVersion.split(".")[0], 10)) {
        fail(
          `tool:${tool.cmd}`,
          `${tool.cmd} ${raw} is below minimum ${tool.minVersion}`,
          tool.remediation,
        );
        continue;
      }
    }

    pass(`tool:${tool.cmd}`, out.replace(/\r?\n.*$/s, "")); // first line only
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 2: Environment variables
// ──────────────────────────────────────────────────────────────────────────────
async function checkEnv(): Promise<void> {
  console.log(c.bold("\n── Environment variables ───────────────────────────────────────"));

  // Check .env file exists
  const envPath = path.join(ROOT, ".env");
  const envExamplePath = path.join(ROOT, ".env.example");

  if (!fs.existsSync(envPath)) {
    fail(
      "env:.env file",
      ".env file not found",
      `Copy the example file: cp .env.example .env\nThen fill in the required values.`,
    );
  } else {
    pass("env:.env file", ".env file exists");
  }

  // Required vars
  const required: Array<{ key: string; description: string; remediation: string }> = [
    {
      key: "DATABASE_URL",
      description: "PostgreSQL connection string",
      remediation:
        "Set DATABASE_URL=postgresql://user:password@localhost:5432/trellis_dev\n" +
        "Start a local DB: docker run -d -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16",
    },
    {
      key: "JWT_SECRET",
      description: "JWT signing secret (32+ char random string)",
      remediation:
        "Generate a secret: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
        "Then set JWT_SECRET=<generated value> in your .env file.",
    },
  ];

  for (const { key, description, remediation } of required) {
    const value = process.env[key];
    if (!value || value.trim() === "") {
      fail(`env:${key}`, `${key} (${description}) is not set`, remediation);
    } else if (/your[-_]?/i.test(value) || /placeholder/i.test(value) || /changeme/i.test(value)) {
      warn(
        `env:${key}`,
        `${key} appears to be a placeholder value`,
        `Replace the placeholder in your .env file with a real value.`,
      );
    } else {
      pass(`env:${key}`, `${key} is set`);
    }
  }

  // Optional-but-recommended vars
  const optional: Array<{ key: string; hint: string }> = [
    { key: "REDIS_URL", hint: "Required for rate limiting, caching, and Bull queues" },
    { key: "STELLAR_HORIZON_URL", hint: "Required for Stellar payment reconciliation" },
    { key: "OPENAI_API_KEY", hint: "Required for AI compute features" },
    { key: "SENTRY_DSN", hint: "Recommended in staging/production for error tracking" },
    { key: "SMTP_HOST", hint: "Required for email notifications" },
  ];

  for (const { key, hint } of optional) {
    const value = process.env[key];
    if (!value || value.trim() === "") {
      warn(`env:${key}`, `${key} is not set (${hint})`, `Add ${key} to your .env if you need this feature.`);
    } else {
      pass(`env:${key}`, `${key} is set`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 3: Database connectivity
// ──────────────────────────────────────────────────────────────────────────────
async function checkDatabase(): Promise<void> {
  console.log(c.bold("\n── Database ─────────────────────────────────────────────────────"));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    skip("db:connectivity", "DATABASE_URL not set — skipping database checks");
    return;
  }

  let host = "localhost";
  let port = 5432;

  try {
    const url = new URL(dbUrl);
    host = url.hostname;
    port = parseInt(url.port || "5432", 10);
  } catch {
    warn("db:url-parse", "Could not parse DATABASE_URL as a URL", "Ensure DATABASE_URL is a valid postgresql:// URI");
  }

  // TCP reachability
  const tcpOk = await probeTcp(host, port);
  if (!tcpOk) {
    fail(
      "db:tcp",
      `Cannot reach PostgreSQL at ${host}:${port}`,
      `Ensure PostgreSQL is running.\n` +
        `Quick start: docker run -d --name trellis-pg -e POSTGRES_PASSWORD=password -p ${port}:5432 postgres:16\n` +
        `Then update DATABASE_URL accordingly.`,
    );
    return;
  }
  pass("db:tcp", `PostgreSQL TCP reachable at ${host}:${port}`);

  // Try a query via psql if available
  const psqlOut = runCmd(`psql "${dbUrl}" -c "SELECT version();" 2>&1`);
  if (psqlOut && psqlOut.includes("PostgreSQL")) {
    pass("db:query", "PostgreSQL SELECT version() succeeded");
  } else if (psqlOut === null) {
    warn("db:query", "psql not available — skipping query check", "Install postgresql-client for a full connectivity test");
  } else {
    fail(
      "db:query",
      `psql query failed: ${psqlOut?.slice(0, 200)}`,
      "Check DATABASE_URL credentials.\nRun: psql \"$DATABASE_URL\" -c 'SELECT 1;'",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 4: Redis connectivity
// ──────────────────────────────────────────────────────────────────────────────
async function checkRedis(): Promise<void> {
  console.log(c.bold("\n── Redis ────────────────────────────────────────────────────────"));

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    warn("redis:config", "REDIS_URL not set — rate limiting and caching will be disabled", "Add REDIS_URL=redis://localhost:6379 to your .env");
    return;
  }

  let host = "localhost";
  let port = 6379;

  try {
    const url = new URL(redisUrl);
    host = url.hostname;
    port = parseInt(url.port || "6379", 10);
  } catch {
    warn("redis:url-parse", "Could not parse REDIS_URL", "Use format: redis://localhost:6379");
  }

  const tcpOk = await probeTcp(host, port);
  if (!tcpOk) {
    fail(
      "redis:tcp",
      `Cannot reach Redis at ${host}:${port}`,
      `Start Redis: docker run -d --name trellis-redis -p 6379:6379 redis:7-alpine\n` +
        `Or: brew services start redis`,
    );
  } else {
    pass("redis:tcp", `Redis TCP reachable at ${host}:${port}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 5: Stellar Horizon
// ──────────────────────────────────────────────────────────────────────────────
async function checkStellar(): Promise<void> {
  console.log(c.bold("\n── Stellar Horizon ──────────────────────────────────────────────"));

  if (QUICK) {
    skip("stellar:horizon", "Skipped in --quick mode");
    return;
  }

  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

  const result = await probeHttp(`${horizonUrl}/`);
  if (result.ok && result.status && result.status < 500) {
    pass("stellar:horizon", `Stellar Horizon reachable at ${horizonUrl} (HTTP ${result.status})`);
  } else {
    warn(
      "stellar:horizon",
      `Stellar Horizon unreachable at ${horizonUrl}`,
      `Check your internet connection.\n` +
        `Set STELLAR_HORIZON_URL in .env (default: https://horizon-testnet.stellar.org).`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 6: SMTP / Email
// ──────────────────────────────────────────────────────────────────────────────
async function checkSmtp(): Promise<void> {
  console.log(c.bold("\n── Email / SMTP ─────────────────────────────────────────────────"));

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT ?? "587", 10);

  if (!smtpHost) {
    warn(
      "smtp:config",
      "SMTP_HOST not set — email notifications will be disabled",
      `For local development use Ethereal: https://ethereal.email\n` +
        `Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD in .env.`,
    );
    return;
  }

  if (QUICK) {
    skip("smtp:tcp", "Skipped in --quick mode");
    return;
  }

  const tcpOk = await probeTcp(smtpHost, smtpPort, 4000);
  if (tcpOk) {
    pass("smtp:tcp", `SMTP TCP reachable at ${smtpHost}:${smtpPort}`);
  } else {
    warn(
      "smtp:tcp",
      `Cannot reach SMTP at ${smtpHost}:${smtpPort}`,
      `Check SMTP_HOST and SMTP_PORT in your .env.\n` +
        `For local dev, use Ethereal (https://ethereal.email) or Mailhog (docker run -p 1025:1025 mailhog/mailhog).`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 7: npm dependencies
// ──────────────────────────────────────────────────────────────────────────────
async function checkDependencies(): Promise<void> {
  console.log(c.bold("\n── Dependencies ─────────────────────────────────────────────────"));

  const nodeModulesPath = path.join(ROOT, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    fail(
      "deps:node_modules",
      "node_modules directory not found",
      "Run: npm install",
    );
    return;
  }

  // Check a few key packages to make sure install is complete
  const keyPackages = ["@nestjs/core", "typeorm", "ioredis", "@stellar/stellar-sdk"];
  let missing: string[] = [];
  for (const pkg of keyPackages) {
    if (!fs.existsSync(path.join(nodeModulesPath, pkg))) {
      missing.push(pkg);
    }
  }

  if (missing.length > 0) {
    fail(
      "deps:packages",
      `Missing packages: ${missing.join(", ")}`,
      "Run: npm install\nIf the issue persists: rm -rf node_modules && npm install",
    );
  } else {
    pass("deps:node_modules", "node_modules present and key packages found");
  }

  // Check for vulnerabilities (non-blocking)
  if (!QUICK) {
    const audit = runCmd("npm audit --audit-level=high --json 2>&1");
    if (audit) {
      try {
        const parsed = JSON.parse(audit);
        const high = parsed?.metadata?.vulnerabilities?.high ?? 0;
        const critical = parsed?.metadata?.vulnerabilities?.critical ?? 0;
        if (critical > 0) {
          warn(
            "deps:audit",
            `npm audit: ${critical} critical, ${high} high severity vulnerabilities`,
            "Run: npm audit fix\nFor manual review: npm audit",
          );
        } else {
          pass("deps:audit", `npm audit: no critical vulnerabilities (${high} high)`);
        }
      } catch {
        skip("deps:audit", "Could not parse npm audit output");
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 8: TypeScript / build sanity
// ──────────────────────────────────────────────────────────────────────────────
async function checkBuild(): Promise<void> {
  console.log(c.bold("\n── Build ────────────────────────────────────────────────────────"));

  if (QUICK) {
    skip("build:typecheck", "Skipped in --quick mode");
    return;
  }

  const tscResult = spawnSync(
    "npx",
    ["tsc", "--noEmit", "--project", "tsconfig.json"],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );

  if (tscResult.status === 0) {
    pass("build:typecheck", "TypeScript type-check passed (tsc --noEmit)");
  } else {
    const errorCount = (tscResult.stdout + tscResult.stderr).match(/error TS/g)?.length ?? "?";
    fail(
      "build:typecheck",
      `TypeScript found ${errorCount} error(s)`,
      "Run: npx tsc --noEmit\nFix the reported type errors before submitting a PR.",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SECTION 9: Test fixtures / validation command
// ──────────────────────────────────────────────────────────────────────────────
async function checkTests(): Promise<void> {
  console.log(c.bold("\n── Test setup ───────────────────────────────────────────────────"));

  if (QUICK) {
    skip("tests:run", "Skipped in --quick mode");
    return;
  }

  const jestResult = spawnSync(
    "npx",
    ["jest", "--testPathPattern=diagnostics|secrets-validation|quota-budget|schema-version|compatibility", "--passWithNoTests", "--silent"],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );

  if (jestResult.status === 0) {
    pass("tests:diagnostics", "Diagnostics-related unit tests pass");
  } else {
    warn(
      "tests:diagnostics",
      "Some diagnostics-related unit tests failed",
      "Run: npm test -- --testPathPattern=diagnostics\nReview test output for details.",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN — run all checks and print summary
// ──────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(c.bold("═══════════════════════════════════════════════════════════════"));
  console.log(c.bold("  Trellis API — Contributor Diagnostics"));
  console.log(c.bold("═══════════════════════════════════════════════════════════════"));

  if (QUICK) {
    console.log(c.yellow("  Running in --quick mode (network checks skipped)\n"));
  }

  await checkTools();
  await checkDependencies();
  await checkEnv();
  await checkDatabase();
  await checkRedis();
  await checkStellar();
  await checkSmtp();
  await checkBuild();
  await checkTests();

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(c.bold("\n═══════════════════════════════════════════════════════════════"));
  console.log(c.bold("  Summary"));
  console.log(c.bold("═══════════════════════════════════════════════════════════════"));

  let passed = 0;
  let failed = 0;
  let warned = 0;
  let skipped = 0;

  for (const r of results) {
    const icon = statusIcon(r.status);
    const label = r.status === "pass" ? c.green(r.status.toUpperCase()) :
                  r.status === "fail" ? c.red(r.status.toUpperCase()) :
                  r.status === "warn" ? c.yellow(r.status.toUpperCase()) :
                  c.dim(r.status.toUpperCase());

    console.log(`  ${icon} ${r.name.padEnd(35)} ${label}  ${c.dim(r.detail)}`);
    if (r.status === "fail" || r.status === "warn") {
      if (r.remediation) {
        const lines = r.remediation.split("\n");
        for (const line of lines) {
          console.log(`    ${c.dim("↳")} ${line}`);
        }
      }
    }

    if (r.status === "pass") passed++;
    else if (r.status === "fail") failed++;
    else if (r.status === "warn") warned++;
    else skipped++;
  }

  console.log(c.bold("\n─────────────────────────────────────────────────────────────────"));
  console.log(
    `  ${c.green(`${passed} passed`)}  ` +
    `${failed > 0 ? c.red(`${failed} failed`) : c.dim(`${failed} failed`)}  ` +
    `${warned > 0 ? c.yellow(`${warned} warnings`) : c.dim(`${warned} warnings`)}  ` +
    `${c.dim(`${skipped} skipped`)}`,
  );

  if (failed > 0) {
    console.log(
      c.red(`\n  ✗ ${failed} check(s) failed. Resolve the issues above before starting development.\n`),
    );
    process.exit(1);
  } else if (warned > 0) {
    console.log(
      c.yellow(`\n  ⚠ Setup is functional with ${warned} warning(s). Some features may be limited.\n`),
    );
    process.exit(0);
  } else {
    console.log(c.green("\n  ✓ All checks passed. Ready for development!\n"));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(c.red("\nDiagnostics script encountered an unexpected error:"));
  console.error(err);
  process.exit(2);
});
