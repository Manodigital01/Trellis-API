import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import { DryRunReconciliationDto } from "./dto/dry-run-reconciliation.dto";
import { DryRunReconciliationService } from "./dry-run-reconciliation.service";

/**
 * Read-only reconcilation reporting for admins.
 *
 * Every route here is a dry run: the report describes drift and suggested
 * repairs, and never mutates invoices, transactions, or balances.
 */
@ApiTags("Stellar Reconciliation")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
@Roles(Role.ADMIN)
@Controller("reconcile/stellar/admin")
export class DryRunReconciliationController {
  constructor(
    private readonly dryRunReconciliationService: DryRunReconciliationService
  ) {}

  @Post("dry-run")
  @ApiOperation({
    summary: "Run a read-only reconciliation dry run",
    description:
      "Compares invoices, ingested Stellar transactions, and (when a balance provider is configured) user-facing balances. Returns findings with suggested repairs and the invariant checks they imply. Writes nothing.",
  })
  @ApiResponse({ status: 201, description: "Dry-run report" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  run(@Body() dto: DryRunReconciliationDto) {
    return this.dryRunReconciliationService.runDryRun(dto);
  }

  @Get("dry-run")
  @ApiOperation({
    summary: "Run a read-only reconciliation dry run (query form)",
    description:
      "Same report as the POST form, for dashboards and cron-like callers that prefer query parameters.",
  })
  @ApiResponse({ status: 200, description: "Dry-run report" })
  runFromQuery(@Query() dto: DryRunReconciliationDto) {
    return this.dryRunReconciliationService.runDryRun(dto);
  }
}
