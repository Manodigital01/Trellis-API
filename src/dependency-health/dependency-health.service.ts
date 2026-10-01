import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type Redis from "ioredis";
import { HEALTH_REDIS_CLIENT } from "../health/health.constants";
import { createProbeContext } from "./dependency-health.probe-io";
import { runDependencyChecks } from "./dependency-health.runner";
import {
  DependencyCheckResult,
  DependencyProbeContext,
  DependencyReport,
} from "./dependency-health.types";
import {
  DependencyHealthSummaryDto,
  toDependencyHealthSummary,
} from "./dto/dependency-health.dto";

export interface RunDependencyHealthOptions {
  /**
   * Permit outbound calls to third-party services. Off for the public
   * endpoint so it can never be used as a request amplifier.
   */
  networkProbes?: boolean;
  /** Bypass the short-lived result cache. */
  refresh?: boolean;
}

interface CacheEntry {
  report: DependencyReport;
  expiresAt: number;
}

/**
 * Reports whether the external services, networks and configuration
 * assumptions Trellis depends on are healthy *before* a workflow fails at
 * runtime.
 *
 * Issue: #124
 */
@Injectable()
export class DependencyHealthService {
  private readonly logger = new Logger(DependencyHealthService.name);
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly degradedLatencyMs: number;
  private readonly cacheTtlMs: number;
  private readonly networkProbesEnabled: boolean;
  private cache: CacheEntry | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(HEALTH_REDIS_CLIENT)
    private readonly redis: Redis | null,
  ) {
    this.enabled =
      String(this.configService.get("DEPENDENCY_HEALTH_ENABLED", "true"))
        .toLowerCase() !== "false";
    this.timeoutMs = Math.max(
      100,
      Number(this.configService.get("DEPENDENCY_HEALTH_TIMEOUT_MS")) || 3000,
    );
    this.degradedLatencyMs =
      Number(this.configService.get("DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS")) ||
      1500;
    this.cacheTtlMs =
      Number(this.configService.get("DEPENDENCY_HEALTH_CACHE_TTL_MS")) || 15000;
    this.networkProbesEnabled =
      String(
        this.configService.get("DEPENDENCY_HEALTH_NETWORK_PROBES", "true"),
      ).toLowerCase() !== "false";
  }

  /** Full report, including configuration keys and sanitized targets. */
  async run(options: RunDependencyHealthOptions = {}): Promise<DependencyReport> {
    if (!this.enabled) {
      return this.disabledReport();
    }
    if (!options.refresh && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.report;
    }

    const networkProbes =
      options.networkProbes === undefined
        ? this.networkProbesEnabled
        : options.networkProbes && this.networkProbesEnabled;

    const report = await runDependencyChecks({ context: this.buildContext(networkProbes) });

    if (this.cacheTtlMs > 0) {
      this.cache = { report, expiresAt: Date.now() + this.cacheTtlMs };
    }
    if (report.status !== "healthy") {
      this.logger.warn(
        `dependency health ${report.status}: ${report.criticalFindings.join(", ") || "none"}`,
      );
    }
    return report;
  }

  /**
   * Compact, non-sensitive view for the public endpoint. Configuration keys
   * and internal targets are dropped; statuses, latencies and remediation
   * hints are kept.
   */
  async getSummary(
    options: RunDependencyHealthOptions = {},
  ): Promise<DependencyHealthSummaryDto> {
    const report = await this.run(options);
    return toDependencyHealthSummary(report);
  }

  /** Drops the cached report. Called by the controller after a forced refresh. */
  invalidateCache(): void {
    this.cache = null;
  }

  private buildContext(networkProbes: boolean): DependencyProbeContext {
    // `process.env` rather than `ConfigService` because the registry reads
    // keys that are not part of `EnvironmentVariables` (Stellar, S3, OTLP...)
    // and because only *names* are ever reported, never values.
    return createProbeContext({
      env: process.env as Record<string, string | undefined>,
      timeoutMs: this.timeoutMs,
      degradedLatencyMs: this.degradedLatencyMs,
      networkProbesEnabled: networkProbes,
      dataSource: this.dataSource,
      redis: this.redis,
    });
  }

  private disabledReport(): DependencyReport {
    const checks: DependencyCheckResult[] = [];
    return {
      status: "healthy",
      advisory: "healthy",
      generatedAt: new Date().toISOString(),
      durationMs: 0,
      counts: {
        healthy: 0,
        degraded: 0,
        unavailable: 0,
        misconfigured: 0,
        disabled: 0,
      },
      criticalFindings: [],
      advisoryFindings: [],
      checks,
      networkProbesSkipped: true,
    };
  }
}
