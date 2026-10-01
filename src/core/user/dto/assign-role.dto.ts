import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { Role } from "src/common/guard/roles.enum";

/**
 * Payload for assigning a role to a user via the admin role-management API.
 *
 * `@IsEnum(Role)` rejects any value outside the canonical role set, closing the
 * privilege-escalation vector of injecting arbitrary role strings.
 */
export class AssignRoleDto {
  @ApiProperty({
    description: "The canonical role to assign to the user.",
    enum: Role,
    example: Role.OPERATOR,
  })
  @IsEnum(Role, {
    message: `role must be one of: ${Object.values(Role).join(", ")}`,
  })
  role: Role;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
