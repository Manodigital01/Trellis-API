import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  DEFAULT_MAX_EDIT_DISTANCE,
  DEFAULT_MIN_SIMILARITY,
} from "../fuzzy-match";

/** Default page size for asset lookups. */
export const DEFAULT_ASSET_SEARCH_LIMIT = 10;
/** Hard cap so one lookup can never pull an unbounded slice of the table. */
export const MAX_ASSET_SEARCH_LIMIT = 50;
/** Longest query accepted; longer strings are almost never an asset name. */
export const MAX_ASSET_SEARCH_QUERY_LENGTH = 64;

export class AssetSearchQueryDto {
  @ApiProperty({
    description:
      "Free-text asset query. 1-2 character typos are tolerated (e.g. `Stelar`, `ETTH`).",
    example: "Stelar",
    minLength: 1,
    maxLength: MAX_ASSET_SEARCH_QUERY_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ASSET_SEARCH_QUERY_LENGTH)
  q: string;

  @ApiPropertyOptional({
    description: "Maximum number of ranked matches to return.",
    default: DEFAULT_ASSET_SEARCH_LIMIT,
    minimum: 1,
    maximum: MAX_ASSET_SEARCH_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ASSET_SEARCH_LIMIT)
  limit?: number;

  @ApiPropertyOptional({
    description: "Restrict the lookup to a single portfolio.",
    format: "uuid",
  })
  @IsOptional()
  @IsUUID()
  portfolioId?: string;

  @ApiPropertyOptional({
    description:
      "Trigram similarity floor for the tolerant stage. Lower values return more, less relevant matches.",
    default: DEFAULT_MIN_SIMILARITY,
    minimum: 0,
    maximum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  minSimilarity?: number;

  @ApiPropertyOptional({
    description:
      "Maximum Levenshtein edit distance still considered a match (covers short tickers where trigrams are weak).",
    default: DEFAULT_MAX_EDIT_DISTANCE,
    minimum: 0,
    maximum: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  maxDistance?: number;

  @ApiPropertyOptional({
    description:
      "Return only exact/prefix/substring matches and skip the typo-tolerant stage.",
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true" || value === "1")
  @IsBoolean()
  exactOnly?: boolean;
}
