import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import {
  AuditActorType,
  SensitiveActionStatus,
} from "../../entities/sensitive-action-event.entity";
import { SensitiveAction } from "../sensitive-action.enum";

/**
 * Contract for recording one sensitive action at the domain boundary.
 *
 * `scope` is intentionally absent: it is derived from the action catalogue so a
 * caller cannot file a treasury action under `authentication`.
 */
export class RecordSensitiveActionDto {
  @ApiProperty({
    enum: SensitiveAction,
    example: SensitiveAction.ROLE_ASSIGNED,
    description: "Declared sensitive action from the catalogue.",
  })
  @IsEnum(SensitiveAction)
  action: SensitiveAction;

  @ApiProperty({ example: "8f1c0f0e-6f0a-4a4f-9d2a-1b2c3d4e5f60" })
  @IsString()
  @MaxLength(64)
  actorId: string;

  @ApiPropertyOptional({ enum: AuditActorType, default: AuditActorType.USER })
  @IsOptional()
  @IsEnum(AuditActorType)
  actorType?: AuditActorType;

  @ApiPropertyOptional({ example: "admin" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorRole?: string;

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

  @ApiPropertyOptional({
    example: "Support escalation #4471 - verified by two officers",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  beforeState?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  afterState?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: SensitiveActionStatus,
    default: SensitiveActionStatus.SUCCEEDED,
  })
  @IsOptional()
  @IsEnum(SensitiveActionStatus)
  status?: SensitiveActionStatus;

  @ApiPropertyOptional({ example: "203.0.113.7" })
  @IsOptional()
  @IsString()
  @MaxLength(45)
  ipAddress?: string;

  @ApiPropertyOptional({ example: "Mozilla/5.0 ..." })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;

  @ApiPropertyOptional({
    example: "2026-09-26T12:00:00.000Z",
    description: "Defaults to the server clock when omitted.",
  })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
