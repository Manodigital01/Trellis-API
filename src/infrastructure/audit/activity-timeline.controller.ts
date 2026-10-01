import {
  Controller,
  Get,
  Query,
  UseGuards,
  Req,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AuditLogService } from "./audit-log.service";
import { AuditLogListResponseDto } from "./dto/audit-log-response.dto";
import { JwtAuthGuard } from "../../core/auth/jwt.guard";

@ApiTags("Activity Timeline")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("activity-timeline")
export class ActivityTimelineController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @ApiOperation({
    summary: "Get user activity timeline",
    description: "Returns a paginated list of public activity events for the authenticated user.",
  })
  @ApiResponse({ status: 200, type: AuditLogListResponseDto })
  async getTimeline(
    @Req() req: any,
    @Query("page") page?: number,
    @Query("limit") limit?: number,
    @Query("cursor") cursor?: string,
  ): Promise<AuditLogListResponseDto> {
    const userId = req.user.id;
    return this.auditLogService.getTimeline(userId, page, limit, cursor);
  }
}
