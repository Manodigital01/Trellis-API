import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  Max,
  Min,
} from "class-validator";

export const DEFAULT_STALE_DAYS = 7;
export const DEFAULT_DRY_RUN_LIMIT = 500;
export const MAX_DRY_RUN_LIMIT = 1000;
export const DEFAULT_TOLERANCE_AMOUNT = "0.0000001";

/**
 * Options for a dry-run reconciliation. Every field is optional; defaults are
 * chosen so the report can be produced on a small local dataset without
 * truncating the interesting rows.
 */
export class DryRunReconciliationDto {
  @ApiPropertyOptional({
    default: DEFAULT_STALE_DAYS,
    minimum: 1,
    maximum: 365,
    description:
      "An unmatched transaction older than this many days is reported as stale.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  staleDays?: number;

  @ApiPropertyOptional({
    default: DEFAULT_DRY_RUN_LIMIT,
    minimum: 1,
    maximum: MAX_DRY_RUN_LIMIT,
    description: "Maximum number of invoices and transactions to inspect.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DRY_RUN_LIMIT)
  limit?: number;

  @ApiPropertyOptional({
    default: DEFAULT_TOLERANCE_AMOUNT,
    description:
      "Absolute amount below which a difference is treated as rounding noise (7 decimal places).",
  })
  @IsOptional()
  @IsNumberString()
  toleranceAmount?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      "Compare derived per-account totals against the user-facing balance provider when one is configured.",
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeUserBalances?: boolean;
}
