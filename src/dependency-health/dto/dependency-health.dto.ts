import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  DependencyCheckResult,
  DependencyKind,
  DependencyReport,
  DependencyState,
  DependencyStateCounts,
  DependencyVerification,
} from "../dependency-health.types";

export class DependencyConfigKeyDto {
  @ApiProperty({
    example: "STELLAR_HORIZON_URL",
    description:
      "Environment variable name. The value is never returned by any endpoint.",
  })
  key: string;

  @ApiProperty({ example: true })
  configured: boolean;
}

export class DependencyCheckDto {
  @ApiProperty({ example: "stellar_horizon" })
  id: string;

  @ApiProperty({ example: "Stellar Horizon API" })
  label: string;

  @ApiProperty({ enum: ["service", "network", "configuration", "storage", "queue"] })
  kind: DependencyKind;

  @ApiProperty({
    enum: ["critical", "optional"],
    description:
      "critical dependencies gate readiness; optional ones are advisory only",
  })
  criticality: "critical" | "optional";

  @ApiProperty({
    enum: ["healthy", "degraded", "unavailable", "misconfigured", "disabled"],
  })
  state: DependencyState;

  @ApiProperty({
    example: "HTTP 200 in 42ms",
    description:
      "Sanitized explanation. Credentials embedded in driver errors are redacted.",
  })
  detail: string;

  @ApiPropertyOptional({ example: 42, description: "Probe latency in ms" })
  latencyMs?: number;

  @ApiPropertyOptional({
    example: "https://horizon-testnet.stellar.org/",
    description: "Target with credentials and query string removed",
  })
  target?: string;

  @ApiPropertyOptional({
    enum: ["network", "database", "configuration", "not-applicable"],
    description: "How the state was established",
  })
  verification?: DependencyVerification;

  @ApiProperty({ type: [DependencyConfigKeyDto] })
  configKeys: DependencyConfigKeyDto[];

  @ApiProperty({
    example: "Horizon is unreachable. Verify egress rules...",
    description: "Actionable next step for the reported state",
  })
  remediation: string;
}

/** Compact public payload: no configuration keys, no internal targets. */
export class DependencyHealthSummaryCheckDto {
  @ApiProperty({ example: "database" })
  id: string;

  @ApiProperty({ example: "PostgreSQL (TypeORM DataSource)" })
  label: string;

  @ApiProperty({ enum: ["service", "network", "configuration", "storage", "queue"] })
  kind: DependencyKind;

  @ApiProperty({ enum: ["critical", "optional"] })
  criticality: "critical" | "optional";

  @ApiProperty({
    enum: ["healthy", "degraded", "unavailable", "misconfigured", "disabled"],
  })
  state: DependencyState;

  @ApiProperty({ example: "SELECT 1 succeeded in 3ms" })
  detail: string;

  @ApiPropertyOptional({ example: 3 })
  latencyMs?: number;

  @ApiProperty({ example: "PostgreSQL is not reachable..." })
  remediation: string;
}

export class DependencyHealthSummaryDto {
  @ApiProperty({
    enum: ["healthy", "degraded", "unavailable", "misconfigured", "disabled"],
    description:
      "Worst state across critical dependencies. unavailable/misconfigured returns HTTP 503.",
  })
  status: DependencyState;

  @ApiProperty({
    enum: ["healthy", "degraded", "unavailable", "misconfigured", "disabled"],
    description: "Worst state across optional dependencies. Informational only.",
  })
  advisory: DependencyState;

  @ApiProperty({ example: "2026-09-27T10:00:00.000Z" })
  generatedAt: string;

  @ApiProperty({ example: 128, description: "Total probe duration in ms" })
  durationMs: number;

  @ApiProperty({ example: ["stellar_horizon", "eth_rpc"] })
  criticalFindings: string[];

  @ApiProperty({ example: ["elasticsearch"] })
  advisoryFindings: string[];

  @ApiProperty({ type: [DependencyHealthSummaryCheckDto] })
  checks: DependencyHealthSummaryCheckDto[];

  @ApiProperty({
    example: true,
    description:
      "True when outbound third-party probes were skipped by policy, so a 'healthy' verdict only reflects local checks.",
  })
  networkProbesSkipped: boolean;
}

export class DependencyHealthReportDto {
  @ApiProperty({
    enum: ["healthy", "degraded", "unavailable", "misconfigured", "disabled"],
  })
  status: DependencyState;

  @ApiProperty({
    enum: ["healthy", "degraded", "unavailable", "misconfigured", "disabled"],
  })
  advisory: DependencyState;

  @ApiProperty()
  generatedAt: string;

  @ApiProperty()
  durationMs: number;

  @ApiProperty({
    example: {
      healthy: 8,
      degraded: 1,
      unavailable: 0,
      misconfigured: 1,
      disabled: 1,
    },
  })
  counts: DependencyStateCounts;

  @ApiProperty({ type: [String] })
  criticalFindings: string[];

  @ApiProperty({ type: [String] })
  advisoryFindings: string[];

  @ApiProperty({ type: [DependencyCheckDto] })
  checks: DependencyCheckDto[];

  @ApiProperty()
  networkProbesSkipped: boolean;
}

export function toDependencyHealthSummary(
  report: DependencyReport,
): DependencyHealthSummaryDto {
  return {
    status: report.status,
    advisory: report.advisory,
    generatedAt: report.generatedAt,
    durationMs: report.durationMs,
    criticalFindings: report.criticalFindings,
    advisoryFindings: report.advisoryFindings,
    networkProbesSkipped: report.networkProbesSkipped,
    checks: report.checks.map((check: DependencyCheckResult) => ({
      id: check.id,
      label: check.label,
      kind: check.kind,
      criticality: check.criticality,
      state: check.state,
      detail: check.detail,
      latencyMs: check.latencyMs,
      remediation: check.remediation,
    })),
  };
}
