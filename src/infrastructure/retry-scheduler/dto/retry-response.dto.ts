import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RetryOperationResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  operationType: string;

  @ApiProperty()
  operationId: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  attempts: number;

  @ApiProperty()
  maxAttempts: number;

  @ApiPropertyOptional()
  lastError?: string;

  @ApiPropertyOptional()
  nextRetryAt?: Date;

  @ApiProperty()
  retryable: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  completedAt?: Date;

  @ApiPropertyOptional()
  deadLetteredAt?: Date;
}

export class RetryMetricsResponse {
  @ApiProperty()
  total: number;

  @ApiProperty()
  pending: number;

  @ApiProperty()
  inProgress: number;

  @ApiProperty()
  succeeded: number;

  @ApiProperty()
  failed: number;

  @ApiProperty()
  deadLettered: number;

  @ApiProperty()
  successRate: number;

  @ApiProperty()
  byType: Record<string, number>;

  @ApiProperty()
  avgAttemptsBeforeSuccess: number;
}

export class DeadLetterListResponse {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ type: [RetryOperationResponse] })
  deadLetters: RetryOperationResponse[];

  @ApiProperty()
  total: number;
}
