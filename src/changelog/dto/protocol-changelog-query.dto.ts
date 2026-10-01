import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsEnum, IsOptional, IsString, Matches } from "class-validator";
import {
  PROTOCOL_CHANGE_IMPACTS,
  ProtocolChangeImpact,
} from "../protocol-changelog.types";

export class ProtocolChangelogQueryDto {
  @ApiPropertyOptional({
    description:
      "Return only entries newer than this version. Callers pin the version they run.",
    example: "0.1.0",
  })
  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/, {
    message: "since must be a semantic version such as 0.1.0",
  })
  since?: string;

  @ApiPropertyOptional({
    description: "Restrict the result to these impact levels.",
    isArray: true,
    enum: PROTOCOL_CHANGE_IMPACTS,
  })
  @IsOptional()
  @IsArray()
  @IsEnum(PROTOCOL_CHANGE_IMPACTS, {
    each: true,
    message: `impact must be one of: ${PROTOCOL_CHANGE_IMPACTS.join(", ")}`,
  })
  impact?: ProtocolChangeImpact[];

  @ApiPropertyOptional({
    description: "Restrict the result to released or unreleased entries.",
    enum: ["released", "unreleased"],
  })
  @IsOptional()
  @IsEnum(["released", "unreleased"] as unknown as object)
  status?: "released" | "unreleased";
}
