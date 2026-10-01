import { IsString, IsOptional, IsEnum, IsDateString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export enum PausableScope {
  TRADING = "trading",
  PAYMENTS = "payments",
  WITHDRAWALS = "withdrawals",
  ORACLE = "oracle",
  RECONCILIATION = "reconciliation",
  DEFI = "defi",
  ALL = "all",
}

export class ActivatePauseDto {
  @ApiProperty({ enum: PausableScope, description: "Scope of operations to pause" })
  @IsEnum(PausableScope)
  scope: PausableScope;

  @ApiProperty({ description: "Reason for activating the pause" })
  @IsString()
  reason: string;

  @ApiPropertyOptional({ description: "Environment to pause (null = all)" })
  @IsOptional()
  @IsString()
  environment?: string;

  @ApiPropertyOptional({ description: "Auto-resume time (ISO 8601)" })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
