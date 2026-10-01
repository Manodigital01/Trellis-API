import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiExtraModels,
} from "@nestjs/swagger";
import { Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { SkipKyc } from "../common/decorators/skip-kyc.decorator";
import {
  HealthResponseDto,
  ComponentStatusDto,
} from "./dto/health-response.dto";
import { HealthService } from "./health.service";

@ApiTags("Health")
@Controller("health")
@Public()
@SkipKyc()
@ApiExtraModels(HealthResponseDto, ComponentStatusDto)
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get(["liveness", "live"])
  @ApiOperation({
    summary: "Liveness probe",
    description:
      "Kubernetes liveness probe. Returns 200 if the process is alive. " +
      "Never checks external dependencies — only confirms the process has not deadlocked.",
    operationId: "getHealthLive",
  })
  @ApiResponse({
    status: 200,
    description: "Process is alive",
    type: HealthResponseDto,
  })
  getLiveness(): HealthResponseDto {
    return this.healthService.getLiveness();
  }

  @Get(["readiness", "ready"])
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Kubernetes readiness probe. Checks database, Redis, and downstream connectivity. " +
      "Returns 200 when all dependencies are reachable, 503 when any critical dependency is down.",
    operationId: "getHealthReady",
  })
  @ApiResponse({
    status: 200,
    description: "All dependencies reachable",
    type: HealthResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: "One or more dependencies unavailable",
    type: HealthResponseDto,
  })
  async getReadiness(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    const result = await this.healthService.getReadiness();
    if (result.status === "error") {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }

  @Get("startup")
  @ApiOperation({
    summary: "Startup probe",
    description:
      "Kubernetes startup probe. Verifies all application components (database, ORM, Redis) " +
      "have fully initialized. Returns 200 once startup is complete, 503 while still starting.",
    operationId: "getHealthStartup",
  })
  @ApiResponse({
    status: 200,
    description: "Application fully started",
    type: HealthResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: "Application still starting",
    type: HealthResponseDto,
  })
  async getStartup(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    const result = await this.healthService.getStartup();
    if (result.status === "error") {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
