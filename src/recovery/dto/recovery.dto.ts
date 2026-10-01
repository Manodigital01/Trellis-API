import { IsEnum, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum RecoveryStateFilter {
  All        = 'all',
  Unresolved = 'unresolved',
  InProgress = 'in_progress',
  Resolved   = 'resolved',
  Dismissed  = 'dismissed',
}

export class ListRecoveryEntriesDto {
  @ApiPropertyOptional({ enum: RecoveryStateFilter, default: RecoveryStateFilter.Unresolved })
  @IsOptional()
  @IsEnum(RecoveryStateFilter)
  state?: RecoveryStateFilter = RecoveryStateFilter.Unresolved;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number = 0;
}

export class TransitionRecoveryStateDto {
  @ApiProperty({ enum: ['in_progress', 'resolved', 'dismissed'], description: 'Target recovery state' })
  @IsEnum(['in_progress', 'resolved', 'dismissed'])
  state: 'in_progress' | 'resolved' | 'dismissed';

  @ApiPropertyOptional({ description: 'Optional note recorded alongside the transition' })
  @IsOptional()
  @IsString()
  note?: string;
}
