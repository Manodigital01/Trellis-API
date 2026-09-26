/**
 * QuotaAdminController — maintainer diagnostics for quota usage.
 *
 * Endpoints are restricted to ADMIN role.  They expose per-actor usage
 * summaries, policy lists, and manual quota resets for operators.
 *
 * Issue: #65
 */

import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags, ApiParam, ApiQuery } from "@nestjs/swagger";
import { Roles } from "../guard/roles.decorator";
import { Role } from "../guard/roles.enum";
import { QuotaBudgetService, UsageSummaryEntry, QuotaPolicy } from "./quota-budget.service";

@ApiTags("Quota Admin")
@Controller("admin/quota")
@Roles(Role.ADMIN)
export class QuotaAdminController {
  constructor(private readonly budget: QuotaBudgetService) {}

  @Get("policies")
  @ApiOperation({
    summary: "List all registered quota policies",
    description: "Returns all active quota policies with their configured limits and window sizes.",
    operationId: "listQuotaPolicies",
  })
  @ApiResponse({ status: 200, description: "Active quota policies" })
  listPolicies(): QuotaPolicy[] {
    return this.budget.listPolicies();
  }

  @Get("usage/:resource")
  @ApiOperation({
    summary: "Get quota usage summary for a resource",
    description:
      "Returns per-actor usage totals for the given resource key. " +
      "Sorted by total consumption descending. Only available to ADMIN role.",
    operationId: "getQuotaUsage",
  })
  @ApiParam({ name: "resource", description: "Resource key, e.g. ai:tokens, compute:job" })
  @ApiResponse({ status: 200, description: "Usage summary entries sorted by total consumption" })
  async getUsage(
    @Param("resource") resource: string,
  ): Promise<UsageSummaryEntry[]> {
    return this.budget.getUsageSummary(resource);
  }

  @Get("peek")
  @ApiOperation({
    summary: "Inspect quota state for a specific actor and resource",
    description: "Returns current usage and remaining quota without consuming any budget.",
    operationId: "peekQuota",
  })
  @ApiQuery({ name: "actor", description: "Actor identifier (user:<id>, wallet:<addr>, ip:<ip>)" })
  @ApiQuery({ name: "resource", description: "Resource key" })
  @ApiResponse({ status: 200, description: "Current quota state for the actor" })
  async peek(
    @Query("actor") actor: string,
    @Query("resource") resource: string,
  ) {
    return this.budget.peek(resource, actor);
  }

  @Delete("reset")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Reset quota for a specific actor and resource",
    description:
      "Clears the current spend counter for the given actor/resource pair. " +
      "Use this for operator overrides, support escalations, or testing. " +
      "Does NOT mutate production data — only clears the in-memory/Redis counter.",
    operationId: "resetQuota",
  })
  @ApiQuery({ name: "actor", description: "Actor identifier" })
  @ApiQuery({ name: "resource", description: "Resource key" })
  @ApiResponse({ status: 204, description: "Quota reset successfully" })
  async reset(
    @Query("actor") actor: string,
    @Query("resource") resource: string,
  ): Promise<void> {
    await this.budget.resetQuota(resource, actor);
  }
}
