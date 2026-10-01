import { Controller, Get, Post, Body, Param, Query, UseGuards, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery, ApiParam } from "@nestjs/swagger";
import { BackgroundWorkerService } from "./background-worker.service";
import { JobStatus, JobPriority, WorkerJobPayload } from "./worker.interface";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles, Role } from "src/common/decorators/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";

@ApiTags("Background Workers")
@ApiBearerAuth()
@Controller("workers")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.OPERATOR)
export class BackgroundWorkerController {
  private readonly logger = new Logger(BackgroundWorkerController.name);

  constructor(private readonly workerService: BackgroundWorkerService) {}

  @Post("jobs")
  @ApiOperation({ summary: "Enqueue a background job" })
  @ApiResponse({ status: 201, description: "Job enqueued successfully" })
  async enqueueJob(@Body() payload: WorkerJobPayload) {
    const job = await this.workerService.enqueue(payload);
    this.logger.log(`Enqueued job ${job.id} via API`);
    return { success: true, job };
  }

  @Get("jobs/:id")
  @ApiOperation({ summary: "Get job details by ID" })
  @ApiParam({ name: "id", description: "Job ID" })
  async getJob(@Param("id") id: string) {
    const job = await this.workerService.getJob(id);
    if (!job) {
      return { success: false, message: "Job not found" };
    }
    return { success: true, job };
  }

  @Get("jobs")
  @ApiOperation({ summary: "List jobs with optional status filter" })
  @ApiQuery({ name: "status", enum: JobStatus, required: false })
  @ApiQuery({ name: "limit", type: Number, required: false })
  async listJobs(@Query("status") status?: JobStatus, @Query("limit") limit?: number) {
    const jobs = await this.workerService.listJobs(status, limit || 50);
    return { success: true, jobs, count: jobs.length };
  }

  @Post("jobs/:id/retry")
  @ApiOperation({ summary: "Retry a failed or dead-lettered job" })
  @ApiParam({ name: "id", description: "Job ID" })
  async retryJob(@Param("id") id: string) {
    const job = await this.workerService.retryJob(id);
    if (!job) {
      return { success: false, message: "Job not found or cannot be retried" };
    }
    return { success: true, job };
  }

  @Post("jobs/:id/cancel")
  @ApiOperation({ summary: "Cancel a pending or active job" })
  @ApiParam({ name: "id", description: "Job ID" })
  async cancelJob(@Param("id") id: string) {
    const cancelled = await this.workerService.cancelJob(id);
    return { success: cancelled, message: cancelled ? "Job cancelled" : "Job cannot be cancelled" };
  }

  @Get("metrics")
  @ApiOperation({ summary: "Get worker metrics and job statistics" })
  async getMetrics() {
    const metrics = await this.workerService.getMetrics();
    return { success: true, metrics };
  }
}
