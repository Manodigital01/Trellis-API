import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty } from "class-validator";
import {
  IsRfcEmail,
  NormalizeEmail,
} from "../../../common/decorators/is-rfc-email.decorator";

export class LinkEmailDto {
  @ApiProperty({
    description: "Email address to link to the user's account",
    required: true,
    example: "newuser@example.com",
  })
  @NormalizeEmail()
  @IsRfcEmail()
  @IsNotEmpty()
  email: string;
}
