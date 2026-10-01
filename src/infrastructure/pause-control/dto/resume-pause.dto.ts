import { IsString, IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { PausableScope } from "./activate-pause.dto";

export class ResumePauseDto {
  @ApiProperty({ enum: PausableScope, description: "Scope to resume" })
  @IsEnum(PausableScope)
  scope: PausableScope;

  @ApiProperty({ description: "Reason for resuming" })
  @IsString()
  reason: string;
}
