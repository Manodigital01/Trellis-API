import { IsEmail, IsEnum, IsNotEmpty } from "class-validator";
import { Role } from "../../../common/guard/roles.enum";

export class CreateInvitationDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsEnum(Role)
  @IsNotEmpty()
  role: Role;
}
