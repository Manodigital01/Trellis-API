import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { timingSafeEqual } from "crypto";
import { JwtAuthGuard } from "../../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../../common/guard/roles.guard";
import { Roles } from "../../common/guard/roles.decorator";
import { Role } from "../../common/guard/roles.enum";
import { MaintainerInsightsService } from "./maintainer-insights.service";
import {
  QueryMaintainerInsightsDto,
  RecordMaintainerEventDto,
  TriggerAggregationDto,
} from "./dto/maintainer-insights.dto";

/**
 * Controller for Maintainer Insights & Privacy-Preserving Analytics.
 *
 * Provides maintainers with usage, performance, and reliability telemetry
 * strictly aggregated across safe, low-cardinality dimensions.
 */
@ApiTags("Monitoring")
@Controller("monitoring/maintainer-insights")
@UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
@Roles(Role.ADMIN, Role.OPERATOR)
@ApiBearerAuth()
export class MaintainerInsightsController {
  constructor(private readonly insightsService: MaintainerInsightsService) {}

  @Get("summary")
  @ApiOperation({
    summary: "Get aggregated maintainer insights summary",
    description:
      "Returns high-level usage totals, reliability rates, latency quantiles, and breakdowns across safe dimensions without exposing private user data.",
  })
  @ApiResponse({ status: 200, description: "Maintainer insights summary" })
  async getSummary(
    @Query() query: QueryMaintainerInsightsDto,
    @Req() req: Request,
  ) {
    this.assertAuthorized(req);
    return this.insightsService.getSummary(query);
  }

  @Get("timeseries")
  @ApiOperation({
    summary: "Query aggregated metrics time series",
    description:
      "Returns time series buckets aggregated by safe dimensions (operation, route, statusCategory, errorCategory, clientType, network).",
  })
  @ApiResponse({ status: 200, description: "Metrics time series" })
  async getTimeseries(
    @Query() query: QueryMaintainerInsightsDto,
    @Req() req: Request,
  ) {
    this.assertAuthorized(req);
    return this.insightsService.getTimeseries(query);
  }

  @Get("reliability")
  @ApiOperation({
    summary: "Get protocol reliability insights",
    description:
      "Reports error distributions, failure rates by operation, and network-level stability without exposing sensitive payload data.",
  })
  @ApiResponse({ status: 200, description: "Reliability insights report" })
  async getReliability(
    @Query() query: QueryMaintainerInsightsDto,
    @Req() req: Request,
  ) {
    this.assertAuthorized(req);
    return this.insightsService.getReliability(query);
  }

  @Get("privacy-boundaries")
  @ApiOperation({
    summary: "Introspect privacy boundary specification",
    description:
      "Returns the formal privacy contract: allowed safe dimensions, strictly prohibited fields, anonymization standards, and retention lifecycle.",
  })
  @ApiResponse({ status: 200, description: "Privacy boundary specification" })
  getPrivacyBoundaries() {
    return this.insightsService.getPrivacyBoundaries();
  }

  @Post("events")
  @ApiOperation({
    summary: "Ingest a protocol telemetry event for maintainer aggregation",
    description:
      "Ingests an event through the privacy gate: scrubs sensitive fields, hashes actor identifiers, and buffers for aggregation.",
  })
  @ApiResponse({ status: 201, description: "Event ingested into privacy buffer" })
  recordEvent(
    @Body() dto: RecordMaintainerEventDto,
    @Req() req: Request,
  ) {
    this.assertAuthorized(req);
    const sanitized = this.insightsService.recordEvent(dto);
    return {
      status: "ingested",
      timeBucket: sanitized.timeBucket,
      operation: sanitized.operation,
      statusCategory: sanitized.statusCategory,
      errorCategory: sanitized.errorCategory,
      network: sanitized.network,
      clientType: sanitized.clientType,
    };
  }

  @Post("aggregate")
  @ApiOperation({
    summary: "Trigger on-demand analytics aggregation",
    description:
      "Manually triggers aggregation of buffered ephemeral events into persistent aggregate records.",
  })
  @ApiResponse({ status: 200, description: "Aggregation result" })
  async triggerAggregation(
    @Body() dto: TriggerAggregationDto,
    @Req() req: Request,
  ) {
    this.assertAuthorized(req);
    const targetDate = dto.targetBucketDate
      ? new Date(dto.targetBucketDate)
      : undefined;
    const result = await this.insightsService.flushAndAggregate(
      targetDate,
      dto.granularity || "hourly",
    );
    return {
      success: true,
      ...result,
    };
  }

  @Post("retention/cleanup")
  @ApiOperation({
    summary: "Trigger on-demand retention policy cleanup",
    description:
      "Purges expired hourly (>30d) and daily (>365d) aggregate metric records.",
  })
  @ApiResponse({ status: 200, description: "Cleanup results" })
  async triggerRetentionCleanup(@Req() req: Request) {
    this.assertAuthorized(req);
    const purged = await this.insightsService.purgeExpiredMetrics();
    return {
      success: true,
      ...purged,
    };
  }

  // Support machine METRICS_AUTH_TOKEN header if provided (constant-time check)
  private assertAuthorized(req: Request): void {
    const expected = process.env.METRICS_AUTH_TOKEN;
    if (!expected) return;

    const header = req.headers["authorization"];
    const headerToken =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
    const queryToken =
      typeof req.query?.token === "string" ? req.query.token : undefined;
    const apiKey =
      typeof req.headers["x-api-key"] === "string"
        ? req.headers["x-api-key"]
        : undefined;

    const provided = headerToken ?? queryToken ?? apiKey;
    if (provided && this.constantTimeEquals(provided, expected)) {
      return; // Token matched successfully
    }
    // If not using METRICS_AUTH_TOKEN, NestJS standard guards (JwtAuthGuard, RolesGuard) apply.
  }

  private constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
