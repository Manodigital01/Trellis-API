import { Controller, Get, HttpStatus, Query, Res, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import { DependencyHealthService } from "./dependency-health.service";
import {
  DependencyCheckDto,
  DependencyConfigKeyDto,
  DependencyHealthReportDto,
  DependencyHealthSummaryCheckDto,
  DependencyHealthSummaryDto,
} from "./dto/dependency-health.dto";

/**
 * Dependency health surface.
 *
 * Two deliberately different audiences:
 *
 * - `GET /health/dependencies` is public and *local only*: it reports status,
 *   latency and remediation but never contacts a third-party service. This
 *   keeps an unauthenticated endpoint from being turned into a request
 *   amplifier against Horizon, RPC providers or SMTP relays.
 * - `GET /health/dependencies/diagnostics` is the maintainer view. It is
 *   admin-only, runs the full probe set (including outbound network checks)
 *   and adds the configuration keys each dependency reads. Values are never
 *   returned by either endpoint.
 *
 * Neither route uses `@SkipKyc()`: both rely on `@Public()` (summary) or the
 * explicit admin guard chain (diagnostics) to satisfy the global `KycGuard`.
 *
 * Issue: #124
 */
@ApiTags("Health")
@Controller("health/dependencies")
@ApiExtraModels(
  DependencyCheckDto,
  DependencyConfigKeyDto,
  DependencyHealthSummaryCheckDto,
)
export class DependencyHealthController {
  constructor(private readonly dependencyHealthService: DependencyHealthService) {}

  @Get()
  @Public()
  @RateLimit({ level: "dependency-health", limit: 10, windowMs: 60_000 })
  @ApiOperation({
    summary: "External dependency health summary",
    description:
      "Reports whether the required external services, networks and configuration " +
      "assumptions are healthy, with remediation hints. Local checks only: no " +
      "outbound request is made to a third-party service from this route. " +
      "Returns 503 when a critical dependency is unavailable or misconfigured.",
    operationId: "getDependencyHealth",
  })
  @ApiResponse({ status: 200, description: "Dependency health summary", type: DependencyHealthSummaryDto })
  @ApiResponse({
    status: 503,
    description: "A critical dependency is unavailable or misconfigured",
    type: DependencyHealthSummaryDto,
  })
  async getSummary(
    @Res({ passthrough: true }) res: Response,
  ): Promise<DependencyHealthSummaryDto> {
    const result = await this.dependencyHealthService.getSummary({
      networkProbes: false,
    });
    if (result.status === "unavailable" || result.status === "misconfigured") {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }

  @Get("diagnostics")
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Maintainer dependency health diagnostics",
    description:
      "Full dependency report for operators: state, latency, sanitized targets, " +
      "the configuration keys each dependency reads and a remediation hint. " +
      "Outbound network probes are enabled by default and can be suppressed with " +
      "'?networkProbes=false'. Secret values are never included in the response.",
    operationId: "getDependencyHealthDiagnostics",
  })
  @ApiQuery({
    name: "refresh",
    required: false,
    type: Boolean,
    description: "Bypass the short-lived report cache",
  })
  @ApiQuery({
    name: "networkProbes",
    required: false,
    type: Boolean,
    description: "Set to false to skip outbound third-party probes",
  })
  @ApiResponse({
    status: 200,
    description: "Full dependency health report",
    type: DependencyHealthReportDto,
  })
  async getDiagnostics(
    @Query("refresh") refresh?: string,
    @Query("networkProbes") networkProbes?: string,
  ): Promise<DependencyHealthReportDto> {
    const report = await this.dependencyHealthService.run({
      refresh: parseBoolean(refresh),
      networkProbes: parseBoolean(networkProbes),
    });
    if (parseBoolean(refresh)) {
      this.dependencyHealthService.invalidateCache();
    }
    return report;
  }
}

function parseBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  return value !== "false" && value !== "0";
}
