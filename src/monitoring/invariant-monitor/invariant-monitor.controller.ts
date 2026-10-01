import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { InvariantMonitorService } from "./invariant-monitor.service";
import { InvariantCategory } from "./invariant.types";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles, Role } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";

@ApiTags("Invariant Monitor")
@ApiBearerAuth()
@Controller("invariant-monitor")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.MAINTAINER)
export class InvariantMonitorController {
  private readonly logger = new Logger(InvariantMonitorController.name);

  constructor(private readonly monitorService: InvariantMonitorService) {}

  @Post("run")
  @ApiOperation({ summary: "Run all invariant checks" })
  @ApiResponse({ status: 200, description: "Invariant report generated" })
  async runAllChecks(@Req() req: any) {
    const userId = req.user?.id ?? "unknown";
    this.logger.log(`Invariant check triggered by user ${userId}`);
    const report = await this.monitorService.runAllChecks(userId);
    return { success: true, report };
  }

  @Post("run/:category")
  @ApiOperation({ summary: "Run invariant checks for a specific category" })
  @ApiParam({
    name: "category",
    enum: InvariantCategory,
    description: "Invariant category",
  })
  async runByCategory(@Param("category") category: InvariantCategory, @Req() req: any) {
    const userId = req.user?.id ?? "unknown";
    const report = await this.monitorService.runChecksByCategory(category, userId);
    return { success: true, report };
  }

  @Get("reports")
  @ApiOperation({ summary: "List past invariant reports" })
  @ApiQuery({ name: "limit", type: Number, required: false })
  async listReports(@Query("limit") limit?: number) {
    const reports = await this.monitorService.getReports(limit || 20);
    return { success: true, reports, count: reports.length };
  }

  @Get("reports/:id")
  @ApiOperation({ summary: "Get a specific invariant report" })
  @ApiParam({ name: "id", description: "Report ID" })
  async getReport(@Param("id") id: string) {
    const report = await this.monitorService.getReport(id);
    if (!report) {
      throw new NotFoundException(`Report ${id} not found`);
    }
    return { success: true, report };
  }

  @Get("invariants")
  @ApiOperation({ summary: "List all registered invariant checks" })
  async listInvariants() {
    const invariants = this.monitorService.getRegisteredInvariants();
    return { success: true, invariants, total: invariants.length };
  }
}
