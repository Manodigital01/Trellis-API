import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { SearchVisibility } from "../entities/search-record.entity";

export class IndexSearchRecordDto {
  @ApiPropertyOptional({
    description: "Existing record ID for an owner-scoped update.",
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty()
  @IsString()
  content: string;

  @ApiPropertyOptional({
    enum: SearchVisibility,
    default: SearchVisibility.PRIVATE,
  })
  @IsOptional()
  @IsEnum(SearchVisibility)
  visibility?: SearchVisibility;
}
