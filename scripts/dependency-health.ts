#!/usr/bin/env ts-node
/**
 * Maintainer-facing dependency health report.
 *
 * Runs exactly the same probe registry as the REST endpoints
 * (`src/dependency-health`) but without booting NestJS, so it can be used on a
 * machine that cannot start the API. All checks are read-only: no data is
 * written and no configuration is modified.
 *
 * Usage:
 *   npm run deps:health                 full report, human readable
 *   npm run deps:health -- --json       machine readable report on stdout
 *   npm run deps:health -- --no-network skip every outbound third-party probe
 *   npm run deps:health -- --timeout 1000
 *   npm run deps:health -- --only database,redis
 *
 * Exit codes:
 *   0  every critical dependency is healthy or degraded
 *   1  a critical dependency is unavailable or misconfigured
 *   2  the report itself could not be produced
 *
 * Issue: #124
 */

import { DEPENDENCY_DEFINITIONS } from "../src/dependency-health/dependency-health.registry";
import { createProbeContext } from "../src/dependency-health/dependency-health.probe-io";
import { runDependencyChecks } from "../src/dependency-health/dependency-health.runner";
import { DependencyState } from "../src/dependency-health/dependency-health.types";
import {
  DependencyReport,
  DependencyStateCounts,
} from "../src/dependency-health/dependency-health.types";

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes("--json");
const NETWORK_PROBES = !args.includes("--no-network");
const ONLY = readOption("--only");
const TIMEOUT = Number(readOption("--timeout") ?? 3000) || 3000;
const DEGRADED_LATENCY = Number(readOption("--degraded-latency") ?? 1500) || 1500;

const COLORS = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

const STATE_COLOR: Record<DependencyState, string> = {
  healthy: COLORS.green,
  degraded: COLORS.yellow,
  unavailable: COLORS.red,
  misconfigured: COLORS.red,
  disabled: COLORS.dim,
};

const STATE_ICON: Record<DependencyState, string> = {
  healthy: "✓",
  degraded: "!",
  unavailable: "✗",
  misconfigured: "✗",
  disabled: "–",
};

function readOption(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function c(text: string, color: string): string {
  if (!process.stdout.isTTY) return text;
  return `${color}${text}${COLORS.reset}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<number> {
  const definitions = ONLY
    ? DEPENDENCY_DEFINITIONS.filter((d) =>
        ONLY.split(",")
          .map((token) => token.trim())
          .includes(d.id),
      )
    : DEPENDENCY_DEFINITIONS;

  if (definitions.length === 0) {
    console.error(`No dependency matched --only ${ONLY}`);
    return 2;
  }

  const context = createProbeContext({
    env: process.env as Record<string, string | undefined>,
    timeoutMs: TIMEOUT,
    degradedLatencyMs: DEGRADED_LATENCY,
    networkProbesEnabled: NETWORK_PROBES,
  });

  const report: DependencyReport = await runDependencyChecks({ context, definitions });

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return report.status === "unavailable" || report.status === "misconfigured"
    ? 1
    : 0;
}

function printReport(report: DependencyReport): void {
  console.log("");
  console.log(c("Trellis dependency health", COLORS.bold));
  console.log(
    c(
      `generated ${report.generatedAt} in ${report.durationMs}ms` +
        (report.networkProbesSkipped ? " (outbound probes disabled)" : ""),
      COLORS.dim,
    ),
  );
  console.log("");
  console.log(
    `  status    ${colorState(report.status, report.status)}` +
      `   advisory ${colorState(report.advisory, report.advisory)}`,
  );
  console.log(
    `  counts    ${formatCounts(report.counts)}`,
  );
  console.log("");

  for (const check of report.checks) {
    const criticality =
      check.criticality === "critical" ? c("critical", COLORS.cyan) : c("optional", COLORS.dim);
    console.log(
      `${c(STATE_ICON[check.state], STATE_COLOR[check.state])} ${pad(check.id, 28)} ` +
        `${pad(check.state, 14)} ${pad(String(check.latencyMs ?? "-"), 7)} ${criticality}`,
    );
    console.log(`    ${c(check.label, COLORS.dim)}`);
    console.log(`    ${check.detail}`);
    if (check.target) console.log(`    ${c(`target ${check.target}`, COLORS.dim)}`);
    const missing = check.configKeys.filter((k) => !k.configured).map((k) => k.key);
    if (missing.length > 0) {
      console.log(`    ${c(`unset: ${missing.join(", ")}`, COLORS.dim)}`);
    }
    if (check.remediation) {
      console.log(`    ↳ ${c(check.remediation, COLORS.yellow)}`);
    }
    console.log("");
  }

  if (report.criticalFindings.length > 0) {
    console.log(
      c(`critical findings: ${report.criticalFindings.join(", ")}`, COLORS.red),
    );
  }
  if (report.advisoryFindings.length > 0) {
    console.log(
      c(`advisory findings: ${report.advisoryFindings.join(", ")}`, COLORS.yellow),
    );
  }
  console.log("");
}

function colorState(state: DependencyState, raw: DependencyState): string {
  return c(`${state}`, STATE_COLOR[raw]);
}

function formatCounts(counts: DependencyStateCounts): string {
  return (Object.keys(counts) as DependencyState[])
    .filter((state) => counts[state] > 0)
    .map((state) => `${state}=${counts[state]}`)
    .join(" ");
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `dependency health report failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(2);
  });
