import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Request,
  UseGuards,
  Delete,
  Param,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AssetSearchService } from "./asset-search.service";
import { AssetSearchQueryDto } from "./dto/asset-search-query.dto";
import { AssetSearchResponse } from "./dto/asset-search-response.dto";
import { SearchService } from "./search.service";
import { JwtAuthGuard } from "../core/auth/jwt.guard";
import { IndexSearchRecordDto } from "./dto/index-search-record.dto";

@ApiTags("search")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("search")
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly assetSearchService: AssetSearchService,
  ) {}

  @Post("index")
  @ApiOperation({ summary: "Index a document in the posts index" })
  async indexPost(
    @Body() post: IndexSearchRecordDto,
    @Request() request: { user: { id: string } },
  ) {
    return this.searchService.indexPost(post, request.user.id);
  }

  @Get()
  @ApiOperation({ summary: "Full-text search across indexed documents" })
  @ApiQuery({ name: "q", required: true, description: "Search query" })
  async search(
    @Query("q") query: string,
    @Request() request: { user: { id: string } },
  ) {
    return this.searchService.search(query, request.user.id);
  }

  @Post(":id/revoke")
  @ApiOperation({ summary: "Revoke a searchable record" })
  async revokePost(
    @Param("id") id: string,
    @Request() request: { user: { id: string } },
  ): Promise<void> {
    return this.searchService.revokePost(id, request.user.id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a searchable record" })
  async deletePost(
    @Param("id") id: string,
    @Request() request: { user: { id: string } },
  ): Promise<void> {
    return this.searchService.deletePost(id, request.user.id);
  }

  @Get("assets")
  @ApiOperation({
    summary: "Typo-tolerant portfolio asset lookup",
    description:
      "Exact, prefix and substring matches first, then a similarity-ranked fallback so 1-2 character typos still resolve. Every hit carries `relevance` (0..1) and the strategy that matched it.",
  })
  @ApiOkResponse({
    description:
      "Ranked asset matches. `fuzzyMode` reports which tolerant stage ran (`trigram`, `levenshtein` or `none`).",
  })
  async searchAssets(
    @Query() query: AssetSearchQueryDto,
    @Request() request: { user: { id: string } },
  ): Promise<AssetSearchResponse> {
    return this.assetSearchService.search(query, request.user.id);
  }
}
