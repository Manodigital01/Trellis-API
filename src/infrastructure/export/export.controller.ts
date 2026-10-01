import { Controller, Post, Get, Body, Param, Query, UseGuards, Request, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery, ApiParam } from "@nestjs/swagger";
import { ExportService } from "./export.service";
import { CreateExportDto, ExportScope } from "./dto/export.dto";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";

@ApiTags("Data Export")
@ApiBearerAuth()
@Controller("exports")
@UseGuards(JwtAuthGuard)
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(private readonly exportService: ExportService) {}

  @Post()
  @ApiOperation({ summary: "Request a data export for the authenticated user" })
  @ApiResponse({ status: 201, description: "Export job created", type: CreateExportDto })
  async createExport(@Body() dto: CreateExportDto, @Request() req: any) {
    const userId = req.user?.publicKey || req.user?.sub || "system";
    const exportJob = await this.exportService.createExport(userId, dto);
    this.logger.log(`User ${userId} requested export ${exportJob.id}`);
    return {
      success: true,
      export: exportJob,
    };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get export status and download URL" })
  @ApiParam({ name: "id", description: "Export ID" })
  async getExport(@Param("id") exportId: string, @Request() req: any) {
    const userId = req.user?.publicKey || req.user?.sub || "system";
    const exportJob = await this.exportService.getExport(userId, exportId);
    return {
      success: true,
      export: exportJob,
    };
  }

  @Get()
  @ApiOperation({ summary: "List all exports for the authenticated user" })
  @ApiQuery({ name: "limit", type: Number, required: false })
  async listExports(@Request() req: any, @Query("limit") limit?: number) {
    const userId = req.user?.publicKey || req.user?.sub || "system";
    const exports = await this.exportService.listExports(userId, limit || 50);
    return {
      success: true,
      exports,
      count: exports.length,
    };
  }
}
