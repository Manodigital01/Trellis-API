import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from "@nestjs/swagger";
import { RetrySchedulerService } from "./retry-scheduler.service";
import { ScheduleRetryDto, RetryDeadLetterDto } from "./dto/schedule-retry.dto";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles, Role } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";

@ApiTags("Retry Scheduler")
@ApiBearerAuth()
@Controller("retry-scheduler")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RetrySchedulerController {
  private readonly logger = new Logger(RetrySchedulerController.name);

  constructor(private readonly retryService: RetrySchedulerService) {}

  @Get("dead-letters")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "List dead-lettered operations" })
  @ApiResponse({ status: 200, description: "Dead letters retrieved" })
  @ApiQuery({ name: "limit", type: Number, required: false })
  @ApiQuery({ name: "offset", type: Number, required: false })
  async getDeadLetters(
    @Query("limit") limit?: number,
    @Query("offset") offset?: number,
  ) {
    const { items, total } = await this.retryService.getDeadLetters(
      limit || 50,
      offset || 0,
    );
    return { success: true, deadLetters: items, total };
  }

  @Get("operations/:operationId")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "Get operation retry status" })
  @ApiResponse({ status: 200, description: "Operation status retrieved" })
  @ApiParam({ name: "operationId", description: "Operation ID" })
  async getOperationStatus(@Param("operationId") operationId: string) {
    const operation = await this.retryService.getOperationStatus(operationId);
    if (!operation) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }
    return { success: true, operation };
  }

  @Post("dead-letters/:operationId/retry")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Manually retry a dead-lettered operation" })
  @ApiResponse({ status: 200, description: "Operation re-queued for retry" })
  @ApiParam({ name: "operationId", description: "Operation ID" })
  async retryDeadLetter(
    @Param("operationId") operationId: string,
    @Body() dto: RetryDeadLetterDto,
  ) {
    const operation = await this.retryService.retryDeadLetter(
      operationId,
      dto.maxAttempts,
    );
    if (!operation) {
      throw new NotFoundException(
        `Dead-lettered operation ${operationId} not found`,
      );
    }
    this.logger.log(`Dead-lettered operation ${operationId} retried via API`);
    return { success: true, operation };
  }

  @Get("metrics")
  @Roles(Role.MAINTAINER)
  @ApiOperation({ summary: "Get retry scheduler metrics" })
  @ApiResponse({ status: 200, description: "Metrics retrieved" })
  async getMetrics() {
    const metrics = await this.retryService.getMetrics();
    return { success: true, metrics };
  }

  @Post("operations")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Schedule an operation for retry management" })
  @ApiResponse({ status: 201, description: "Operation scheduled" })
  async scheduleOperation(@Body() dto: ScheduleRetryDto) {
    const operation = await this.retryService.schedule(dto);
    this.logger.log(`Operation ${dto.operationId} scheduled via API`);
    return { success: true, operation };
  }
}
