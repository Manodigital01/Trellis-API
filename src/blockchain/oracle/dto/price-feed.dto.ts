import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsString, IsOptional, IsInt, Min, Max } from "class-validator";
import { SupportedChain, PriceSource } from "../entities/price-record.entity";

export class GetPriceDto {
  @ApiProperty({ example: "ETH", description: "Asset symbol" })
  @IsString()
  asset: string;

  @ApiProperty({ enum: SupportedChain, example: SupportedChain.ETHEREUM })
  @IsEnum(SupportedChain)
  chain: SupportedChain;
}

export class GetHistoricalPricesDto {
  @ApiProperty({ example: "ETH" })
  @IsString()
  asset: string;

  @ApiProperty({ enum: SupportedChain })
  @IsEnum(SupportedChain)
  chain: SupportedChain;

  @ApiPropertyOptional({
    example: 100,
    default: 100,
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 100;
}

export class SourcePriceDto {
  @ApiPropertyOptional({ example: 2000.5 })
  chainlink?: number;

  @ApiPropertyOptional({ example: 2001.0 })
  band?: number;

  @ApiPropertyOptional({ example: 1999.8 })
  uniswap_twap?: number;
}

export class PriceResponseDto {
  @ApiProperty({ example: "ETH" })
  asset: string;

  @ApiProperty({ enum: SupportedChain })
  chain: SupportedChain;

  @ApiProperty({ example: 2000.43 })
  price: number;

  @ApiProperty({ type: SourcePriceDto })
  sourcePrices: Record<PriceSource, number>;

  @ApiProperty({ example: false })
  deviationAlert: boolean;

  @ApiProperty({ example: 0.0612 })
  maxDeviationPercent: number;

  @ApiProperty({
    example: false,
    description:
      "True when at least one oracle feed was rejected for being older than the freshness window",
  })
  stale: boolean;

  @ApiProperty({
    example: false,
    description:
      "True when no feed was fresh and the last known valid price was reused",
  })
  usedFallbackPrice: boolean;

  @ApiProperty({
    type: [String],
    example: [],
    description: "Oracle feeds discarded for exceeding the freshness window",
  })
  staleSources: PriceSource[];

  @ApiProperty({
    type: [String],
    example: [],
    description: "Oracle feeds discarded as >5% statistical outliers",
  })
  outliers: PriceSource[];

  @ApiProperty({
    type: [String],
    example: ["chainlink", "band"],
    description: "Oracle feeds the median price was computed from",
  })
  acceptedSources: PriceSource[];

  @ApiProperty()
  timestamp: Date;
}

export class OracleQuoteDto {
  @ApiProperty({ enum: PriceSource, example: PriceSource.CHAINLINK })
  source: PriceSource;

  @ApiProperty({ example: 2000.5, nullable: true })
  price: number | null;

  @ApiProperty({
    example: 12,
    nullable: true,
    description: "Age of the feed in seconds; null when the source reports no timestamp",
  })
  ageSeconds: number | null;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z", nullable: true })
  updatedAt: Date | null;

  @ApiProperty({ example: true })
  accepted: boolean;

  @ApiProperty({ example: 0.04, nullable: true })
  deviationPercent: number | null;

  @ApiProperty({
    enum: ["unavailable", "stale", "outlier"],
    example: "stale",
    required: false,
    description: "Why the feed was discarded; absent when it was accepted",
  })
  reason?: "unavailable" | "stale" | "outlier";
}

export class OracleAggregateDto {
  @ApiProperty({ example: "ETH" })
  asset: string;

  @ApiProperty({ enum: SupportedChain })
  chain: SupportedChain;

  @ApiProperty({ example: 2000.43 })
  price: number;

  @ApiProperty({
    enum: ["high", "medium", "low", "none"],
    example: "high",
    description: "Based on how many independent feeds survived filtering",
  })
  confidence: string;

  @ApiProperty({ example: false })
  stale: boolean;

  @ApiProperty({ example: false })
  usedFallbackPrice: boolean;

  @ApiProperty({ example: 0.0612 })
  maxDeviationPercent: number;

  @ApiProperty({ example: 60 })
  maxAgeSeconds: number;

  @ApiProperty({ type: [OracleQuoteDto] })
  quotes: OracleQuoteDto[];
}

export class OracleAggregationQueryDto {
  @ApiPropertyOptional({
    example: 60,
    default: 60,
    minimum: 1,
    maximum: 3600,
    description: "Freshness window for an oracle feed, in seconds",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  maxAgeSeconds?: number = 60;
}
