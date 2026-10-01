import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { ComplianceOfficerGuard } from "../guards/compliance-officer.guard";
import { AuditActorType } from "../entities/sensitive-action-event.entity";
import { SensitiveActionAuditService } from "./sensitive-action-audit.service";
import {
  ExportSensitiveActionsDto,
  QuerySensitiveActionDto,
} from "./dto/query-sensitive-action.dto";
import { SensitiveAction } from "./sensitive-action.enum";

/**
 * Maintainer-facing read API for the sensitive action trail.
 *
 * Writing is deliberately *not* exposed over HTTP: events are recorded by the
 * domain service that performs the action, which keeps attribution honest and
 * prevents a client from inventing an audit record.
 */
@ApiTags("Sensitive Action Audit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ComplianceOfficerGuard)
@Controller("audit-trail/sensitive-actions")
export class SensitiveActionAuditController {
  constructor(private readonly auditService: SensitiveActionAuditService) {}

  @Get()
  @ApiOperation({
    summary: "Query sensitive action events",
    description:
      "Filter by actor, action, scope, resource, status, and date range. Newest first, 500 records per page max.",
  })
  @ApiResponse({ status: 200, description: "Paginated audit events" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  query(@Query() dto: QuerySensitiveActionDto) {
    return this.auditService.query(dto);
  }

  @Get("catalogue")
  @ApiOperation({
    summary: "List the sensitive actions covered by the audit trail",
    description:
      "Returns each action with its scope, description, and whether a reason or before/after state is required.",
  })
  catalogue() {
    return { actions: this.auditService.catalogue() };
  }

  @Get("integrity")
  @ApiOperation({
    summary: "Verify the audit hash chain",
    description:
      "Recomputes the event hash chain and reports the first broken link, if any.",
  })
  integrity() {
    return this.auditService.verifyChain();
  }

  @Get("export")
  @ApiOperation({
    summary: "Export sensitive action events for review",
    description:
      "Returns a JSON export plus the chain status at export time. The export itself is recorded as an audit event.",
  })
  async export(
    @Query() dto: ExportSensitiveActionsDto,
    @Req() request: Request & { user?: Record<string, string> },
    @Res() response: Response
  ): Promise<void> {
    const result = await this.auditService.exportForReview(dto);

    await this.auditService.recordSensitiveAction({
      action: SensitiveAction.AUDIT_LOG_EXPORTED,
      actorId:
        request.user?.id ?? request.user?.userId ?? request.user?.sub ?? "unknown-actor",
      actorType: AuditActorType.MAINTAINER,
      actorRole: request.user?.role,
      reason: "Audit trail export requested through the maintainer API",
      metadata: {
        filters: {
          actorId: dto.actorId,
          action: dto.action,
          scope: dto.scope,
          resourceType: dto.resourceType,
          resourceId: dto.resourceId,
          status: dto.status,
          from: dto.from,
          to: dto.to,
        },
        exportedCount: result.count,
        chainVerified: result.chainVerified,
      },
      ipAddress: request.ip,
      userAgent: request.headers?.["user-agent"],
    });

    response.setHeader("Content-Type", "application/json");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="sensitive-actions-${Date.now()}.json"`
    );
    response.setHeader("X-Chain-Verified", String(result.chainVerified));
    response.send(result.payload);
  }

  @Get("resource/:resourceType/:resourceId")
  @ApiOperation({
    summary: "Full sensitive action history for one resource",
    description: "Oldest first, so the timeline reads top to bottom.",
  })
  @ApiParam({ name: "resourceType", example: "user" })
  @ApiParam({ name: "resourceId", example: "usr_01H..." })
  @ApiQuery({ name: "limit", required: false, type: Number, example: 100 })
  history(
    @Param("resourceType") resourceType: string,
    @Param("resourceId") resourceId: string,
    @Query("limit") limit?: string
  ) {
    return this.auditService.historyFor(
      resourceType,
      resourceId,
      limit ? Number(limit) : 100
    );
  }
}
