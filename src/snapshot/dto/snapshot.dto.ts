import { IsOptional, IsString, IsArray, IsIn, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class RequestSnapshotDto {
  @ApiProperty({
    description: 'Scope of state to capture',
    enum: ['agents', 'portfolios', 'jobs', 'audit', 'full'],
    example: 'agents',
  })
  @IsIn(['agents', 'portfolios', 'jobs', 'audit', 'full'])
  scope: string;

  @ApiPropertyOptional({ description: 'Optional label for the snapshot', example: 'pre-deploy-2026-09-27' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ description: 'Extra resource IDs to include', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  resourceIds?: string[];

  @ApiPropertyOptional({ description: 'Max records per scope section', minimum: 1, maximum: 10000, default: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  @Type(() => Number)
  limit?: number;
}

export class VerifySnapshotDto {
  @ApiProperty({ description: 'Snapshot ID to verify' })
  @IsString()
  snapshotId: string;

  @ApiPropertyOptional({ description: 'Expected HMAC signature for cross-check' })
  @IsOptional()
  @IsString()
  expectedSignature?: string;
}
