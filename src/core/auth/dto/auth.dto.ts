import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  IsOptional,
} from "class-validator";
import {
  IsRfcEmail,
  NormalizeEmail,
} from "../../../common/decorators/is-rfc-email.decorator";

export class RegisterDto {
  @ApiProperty({
    description: "Username for the new user (optional for wallet auth)",
    required: false,
    example: "johndoe",
  })
  @IsString()
  @IsNotEmpty()
  @IsOptional() // Optional for backward compatibility with wallet auth
  username?: string;

  @ApiProperty({
    description: "User's email address",
    required: true,
    example: "user@example.com",
  })
  @NormalizeEmail()
  @IsRfcEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: "User's password (min 8 characters)",
    required: true,
    example: "strongPassword123",
  })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({
    description: "Referral code from an existing user",
    required: false,
    example: "ABC123XYZ",
  })
  @IsString()
  @IsOptional()
  referralCode?: string;
}

export class LoginDto {
  @ApiProperty({
    description: "User's email address",
    required: true,
    example: "user@example.com",
  })
  @NormalizeEmail()
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: "User's password",
    required: true,
    example: "strongPassword123",
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    description: "Refresh token to get a new access token",
    required: true,
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class TwoFactorVerifyDto {
  @ApiProperty({
    description: "Two-factor authentication code",
    required: false,
    example: "123456",
  })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiProperty({
    description: "Two-factor authentication backup code",
    required: false,
    example: "ABCD-EFGH-IJKL-MNOP",
  })
  @IsString()
  @IsOptional()
  backupCode?: string;
}

export class AuthUserDto {
  @ApiProperty({ description: "User's unique ID", required: true })
  id: string;

  @ApiProperty({ description: "User's email address", required: true })
  email: string;

  @ApiProperty({ description: "User's username", required: false })
  username?: string;

  @ApiProperty({ description: "User's role", required: true })
  role: string;
}

export class AuthStatusDto {
  @ApiProperty({
    description: "Whether the user is authenticated",
    required: true,
  })
  isAuthenticated: boolean;

  @ApiProperty({
    description: "Authenticated user details",
    required: false,
    type: AuthUserDto,
  })
  user?: AuthUserDto;
}
