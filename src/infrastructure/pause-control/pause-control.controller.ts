import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  UseGuards,
  Logger,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { PauseControlService } from "./pause-control.service";
import { ActivatePauseDto } from "./dto/activate-pause.dto";
import { ResumePauseDto } from "./dto/resume-pause.dto";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles, Role } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";

@ApiTags("Pause Control")
@ApiBearerAuth()
@Controller("pause-control")
@UseGuards(JwtAuthGuard, RolesGuard)
export class PauseControlController {
  private readonly logger = new Logger(PauseControlController.name);

  constructor(private readonly pauseService: PauseControlService) {}

  @Post("activate")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Activate emergency pause on a scope" })
  @ApiResponse({ status: 201, description: "Pause activated" })
  async activatePause(@Body() dto: ActivatePauseDto, @Req() req: any) {
    const user = req.user;
    const pause = await this.pauseService.activatePause({
      scope: dto.scope,
      reason: dto.reason,
      actorId: user?.id ?? "unknown",
      actorRole: user?.role ?? "unknown",
      environment: dto.environment,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
    this.logger.warn(
      `Pause activated on '${dto.scope}' by ${user?.id}: ${dto.reason}`,
    );
    return { success: true, pause };
  }

  @Post("resume")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Resume a paused scope" })
  @ApiResponse({ status: 200, description: "Pause resumed" })
  async resumePause(@Body() dto: ResumePauseDto, @Req() req: any) {
    const user = req.user;
    const pause = await this.pauseService.resumePause(
      dto.scope,
      dto.reason,
      user?.id ?? "unknown",
      user?.role ?? "unknown",
    );
    if (!pause) {
      throw new BadRequestException(
        `No active pause found for scope '${dto.scope}'`,
      );
    }
    return { success: true, pause };
  }

  @Get("status")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "Get all active pauses" })
  @ApiResponse({ status: 200, description: "Active pauses" })
  async getStatus() {
    const pauses = await this.pauseService.getActivePauses();
    return { success: true, pauses, count: pauses.length };
  }

  @Get("history")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "Get pause history" })
  @ApiQuery({ name: "scope", required: false })
  @ApiQuery({ name: "limit", type: Number, required: false })
  async getHistory(
    @Query("scope") scope?: string,
    @Query("limit") limit?: number,
  ) {
    const history = await this.pauseService.getPauseHistory(
      scope,
      limit || 50,
    );
    return { success: true, history, count: history.length };
  }

  @Get("audit")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Get pause audit log" })
  @ApiQuery({ name: "pauseScopeId", required: false })
  @ApiQuery({ name: "limit", type: Number, required: false })
  async getAuditLog(
    @Query("pauseScopeId") pauseScopeId?: string,
    @Query("limit") limit?: number,
  ) {
    const log = await this.pauseService.getAuditLog(
      pauseScopeId,
      limit || 100,
    );
    return { success: true, log, count: log.length };
  }
}
