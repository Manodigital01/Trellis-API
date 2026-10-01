import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export enum MetricGranularity {
  HOURLY = "hourly",
  DAILY = "daily",
}

export class QueryMaintainerInsightsDto {
  @ApiPropertyOptional({
    description: "Start of query window (ISO date or timestamp)",
    example: "2026-09-26T00:00:00.000Z",
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({
    description: "End of query window (ISO date or timestamp)",
    example: "2026-09-26T23:59:59.000Z",
  })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({
    description: "Metric bucket granularity ('hourly' or 'daily')",
    enum: MetricGranularity,
    default: MetricGranularity.HOURLY,
  })
  @IsOptional()
  @IsEnum(MetricGranularity)
  granularity?: MetricGranularity;

  @ApiPropertyOptional({
    description: "Filter by Trellis protocol operation",
    example: "oracle.price_feed",
  })
  @IsOptional()
  @IsString()
  operation?: string;

  @ApiPropertyOptional({
    description: "Filter by normalized route path",
    example: "/api/v1/oracle/payloads",
  })
  @IsOptional()
  @IsString()
  route?: string;

  @ApiPropertyOptional({
    description: "Filter by HTTP status category ('2xx', '4xx', '5xx')",
    example: "2xx",
  })
  @IsOptional()
  @IsString()
  statusCategory?: string;

  @ApiPropertyOptional({
    description: "Filter by safe error category",
    example: "VALIDATION_ERROR",
  })
  @IsOptional()
  @IsString()
  errorCategory?: string;

  @ApiPropertyOptional({
    description: "Filter by client tier ('agent', 'operator', 'web', 'indexer', 'sdk')",
    example: "agent",
  })
  @IsOptional()
  @IsString()
  clientType?: string;

  @ApiPropertyOptional({
    description: "Filter by network ('mainnet', 'testnet', 'sandbox')",
    example: "mainnet",
  })
  @IsOptional()
  @IsString()
  network?: string;

  @ApiPropertyOptional({
    description: "Maximum number of aggregate records to return",
    default: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 100;

  @ApiPropertyOptional({
    description: "Offset for pagination",
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class RecordMaintainerEventDto {
  @ApiProperty({
    description: "Trellis protocol operation name",
    example: "oracle.price_feed",
  })
  @IsString()
  operation: string;

  @ApiPropertyOptional({
    description: "API route endpoint (will be normalized automatically)",
    example: "/api/v1/oracle/payloads",
  })
  @IsOptional()
  @IsString()
  route?: string;

  @ApiPropertyOptional({
    description: "HTTP status code",
    example: 200,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  statusCode?: number;

  @ApiPropertyOptional({
    description: "Execution duration in milliseconds",
    example: 45.2,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  latencyMs?: number;

  @ApiPropertyOptional({
    description:
      "Ephemeral actor identifier for distinct count calculation. Scrubbed and hashed with daily salt; never saved in plain text.",
  })
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({
    description: "Actor role category ('user', 'service_actor', 'operator', 'admin')",
    example: "service_actor",
  })
  @IsOptional()
  @IsString()
  actorType?: string;

  @ApiPropertyOptional({
    description: "Client type ('agent', 'web', 'sdk', 'indexer')",
    example: "agent",
  })
  @IsOptional()
  @IsString()
  clientType?: string;

  @ApiPropertyOptional({
    description: "Network environment ('mainnet', 'testnet', 'sandbox')",
    example: "mainnet",
  })
  @IsOptional()
  @IsString()
  network?: string;

  @ApiPropertyOptional({
    description: "Error code for classification (sanitized upon ingestion)",
    example: "ORACLE_DRIFT",
  })
  @IsOptional()
  @IsString()
  errorCode?: string;

  @ApiPropertyOptional({
    description: "Error message for classification (sanitized; raw text not stored)",
    example: "Price drift exceeded threshold",
  })
  @IsOptional()
  @IsString()
  errorMessage?: string;
}

export class TriggerAggregationDto {
  @ApiPropertyOptional({
    description: "Target bucket date (ISO string). Defaults to current hour.",
  })
  @IsOptional()
  @IsString()
  targetBucketDate?: string;

  @ApiPropertyOptional({
    description: "Granularity to aggregate ('hourly' or 'daily')",
    enum: MetricGranularity,
    default: MetricGranularity.HOURLY,
  })
  @IsOptional()
  @IsEnum(MetricGranularity)
  granularity?: MetricGranularity;
}
