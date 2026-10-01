import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { PreflightService } from "./preflight.service";
import { PreflightRequestDto } from "./dto/preflight-request.dto";
import { PreflightResult } from "./preflight.types";

/**
 * Deterministic transaction simulation preflight (issue #109).
 *
 * `POST /preflight` always returns 200 with the evaluation result so a client
 * can render success / warning / blocking findings before it ever submits.
 * `POST /preflight/assert` is the gate: it throws the standard error envelope
 * (HTTP 422 `PRECONDITION_FAILED`) when the result is blocking, which is what
 * callers use immediately before submitting a high-risk operation.
 */
@ApiTags("Preflight")
@ApiBearerAuth()
@Controller("preflight")
@UseGuards(JwtAuthGuard)
export class PreflightController {
  constructor(private readonly preflightService: PreflightService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Evaluate a high-risk operation before submission",
    description:
      "Returns a success, warning or blocking result with user-safe findings and remediation steps.",
  })
  @ApiResponse({ status: 200, description: "Preflight result" })
  @ApiResponse({ status: 401, description: "Authentication required" })
  evaluate(
    @Body() dto: PreflightRequestDto,
    @Req() request?: any,
  ): Promise<PreflightResult> {
    return this.preflightService.preflight(dto, this.actor(request));
  }

  @Post("assert")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Evaluate and refuse a blocked operation",
    description:
      "Identical evaluation to POST /preflight, but a blocking result is returned as HTTP 422 PRECONDITION_FAILED.",
  })
  @ApiResponse({ status: 200, description: "Operation may proceed" })
  @ApiResponse({ status: 422, description: "Operation blocked by preflight" })
  async assertProceedable(
    @Body() dto: PreflightRequestDto,
    @Req() request?: any,
  ): Promise<PreflightResult> {
    const result = await this.preflightService.preflight(
      dto,
      this.actor(request),
    );
    return this.preflightService.assertProceedable(result);
  }

  private actor(request?: any): string | undefined {
    const id = request?.user?.sub ?? request?.user?.id;
    return id === undefined || id === null ? undefined : String(id);
  }
}
