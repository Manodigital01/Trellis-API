import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { SensitiveActionStatus } from "../../entities/sensitive-action-event.entity";
import {
  SensitiveAction,
  SensitiveActionScope,
} from "../sensitive-action.enum";

export const SENSITIVE_ACTION_MAX_LIMIT = 500;
export const SENSITIVE_ACTION_EXPORT_LIMIT = 10000;

export class QuerySensitiveActionDto {
  @ApiPropertyOptional({ example: "usr_01H..." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  @ApiPropertyOptional({ enum: SensitiveAction })
  @IsOptional()
  @IsEnum(SensitiveAction)
  action?: SensitiveAction;

  @ApiPropertyOptional({ enum: SensitiveActionScope })
  @IsOptional()
  @IsEnum(SensitiveActionScope)
  scope?: SensitiveActionScope;

  @ApiPropertyOptional({ example: "user" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceType?: string;

  @ApiPropertyOptional({ example: "usr_01H..." })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  resourceId?: string;

  @ApiPropertyOptional({ enum: SensitiveActionStatus })
  @IsOptional()
  @IsEnum(SensitiveActionStatus)
  status?: SensitiveActionStatus;

  @ApiPropertyOptional({ example: "2026-09-01T00:00:00.000Z" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-30T23:59:59.000Z" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: SENSITIVE_ACTION_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SENSITIVE_ACTION_MAX_LIMIT)
  limit?: number;
}

export class ExportSensitiveActionsDto extends QuerySensitiveActionDto {
  @ApiPropertyOptional({
    default: SENSITIVE_ACTION_EXPORT_LIMIT,
    maximum: SENSITIVE_ACTION_EXPORT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SENSITIVE_ACTION_EXPORT_LIMIT)
  limit?: number;
}
