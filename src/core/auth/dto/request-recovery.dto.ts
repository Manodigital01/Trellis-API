import { IsEmail } from "class-validator";
import { NormalizeEmail } from "../../../common/decorators/is-rfc-email.decorator";
import { ApiProperty } from "@nestjs/swagger";

export class RequestRecoveryDto {
  @ApiProperty({
    description: "The email address to send the recovery link to.",
    example: "user@example.com",
  })
  @NormalizeEmail()
  @IsEmail()
  email: string;
}
