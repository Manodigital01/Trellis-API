import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsBoolean,
  IsObject,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class ScheduleRetryDto {
  @ApiProperty({ description: "Type of operation (e.g., webhook.delivery, payment.submit)" })
  @IsString()
  operationType: string;

  @ApiProperty({ description: "Unique external identifier for the operation" })
  @IsString()
  operationId: string;

  @ApiProperty({ description: "Operation payload data" })
  @IsObject()
  payload: any;

  @ApiPropertyOptional({ description: "Maximum retry attempts", default: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxAttempts?: number;

  @ApiPropertyOptional({ description: "Initial backoff in milliseconds", default: 1000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  backoffMs?: number;

  @ApiPropertyOptional({ description: "Backoff multiplier", default: 2 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  backoffMultiplier?: number;

  @ApiPropertyOptional({ description: "Maximum backoff in milliseconds", default: 60000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  maxBackoffMs?: number;

  @ApiPropertyOptional({ description: "Whether the operation is retryable", default: true })
  @IsOptional()
  @IsBoolean()
  retryable?: boolean;

  @ApiPropertyOptional({ description: "Correlation ID for tracing" })
  @IsOptional()
  @IsString()
  correlationId?: string;

  @ApiPropertyOptional({ description: "Additional metadata" })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class RetryDeadLetterDto {
  @ApiPropertyOptional({ description: "Reset max attempts for the retry" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxAttempts?: number;
}
