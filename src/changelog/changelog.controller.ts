import { Controller, Get, Query } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "../common/decorators/public.decorator";
import { ProtocolChangelogQueryDto } from "./dto/protocol-changelog-query.dto";
import {
  ProtocolChangelogResponseDto,
  ProtocolChangeEntryDto,
  ProtocolMigrationDto,
  ProtocolSurfaceDto,
  ProtocolBreakingChangeDto,
  ProtocolDeprecationDto,
} from "./dto/protocol-changelog-response.dto";
import {
  ProtocolChangelogService,
  ProtocolChangelogView,
} from "./protocol-changelog.service";

/**
 * Machine-readable changelog of protocol-facing behaviour changes.
 *
 * Issue: #126
 */
@ApiTags("Changelog")
@Controller("changelog")
@Public()
@ApiExtraModels(
  ProtocolChangelogResponseDto,
  ProtocolChangeEntryDto,
  ProtocolSurfaceDto,
  ProtocolMigrationDto,
  ProtocolBreakingChangeDto,
  ProtocolDeprecationDto,
)
export class ChangelogController {
  constructor(private readonly changelogService: ProtocolChangelogService) {}

  @Get("protocol")
  @ApiOperation({
    summary: "Protocol-facing changes, newest first",
    description:
      "Every change to an HTTP route, WebSocket or GraphQL surface, configuration key or " +
      "operator command, with its impact on existing callers and the migration that applies. " +
      "Pass `since` with the version you run to learn what an upgrade would do to you.",
    operationId: "getProtocolChangelog",
  })
  @ApiResponse({
    status: 200,
    description: "Matching changelog entries",
    type: ProtocolChangelogResponseDto,
  })
  getProtocolChangelog(
    @Query() query: ProtocolChangelogQueryDto,
  ): ProtocolChangelogResponseDto {
    const view: ProtocolChangelogView = this.changelogService.query({
      since: query.since,
      impact: query.impact,
      status: query.status,
    });
    return view as unknown as ProtocolChangelogResponseDto;
  }
}
