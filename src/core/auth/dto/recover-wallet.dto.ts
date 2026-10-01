import { IsEmail, IsString, Length } from "class-validator";
import { NormalizeEmail } from "../../../common/decorators/is-rfc-email.decorator";
import { ApiProperty } from "@nestjs/swagger";

export class RecoverWalletDto {
  @ApiProperty({
    description: "The user's email address.",
    example: "user@example.com",
  })
  @NormalizeEmail()
  @IsEmail()
  email: string;

  @ApiProperty({
    description: "The recovery token from the email.",
    example: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  })
  @IsString()
  @Length(64, 64)
  recoveryToken: string;
}
