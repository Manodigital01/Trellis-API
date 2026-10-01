import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional } from "class-validator";
import {
  SectionRisk,
  TransactionDetailTier,
  TransactionSectionId,
  TransactionWarningCode,
  TransactionWarningSeverity,
} from "../transaction-detail.types";

/**
 * Query contract for progressive disclosure. Omitting `details` keeps the
 * legacy response shape; the explicit tiers opt in to the new envelope.
 */
export class TransactionDetailsQueryDto {
  @ApiPropertyOptional({
    enum: TransactionDetailTier,
    description:
      "How much detail to return. `summary` returns identity + settlement + risk, " +
      "`standard` (default when specified) adds timeline and the reconciliation audit, " +
      "`advanced` additionally returns amount precision, reference analysis and the raw " +
      "protocol payload. Warnings and critical-risk sections are returned at every tier.",
  })
  @IsOptional()
  @IsEnum(TransactionDetailTier)
  details?: TransactionDetailTier;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      "Only meaningful on write endpoints. Validates and projects the payload " +
      "without persisting anything, so advanced details are inspectable before submission.",
  })
  @IsOptional()
  dryRun?: boolean;
}

export class TransactionSectionStateDto {
  @ApiProperty({
    enum: [
      "identity",
      "settlement",
      "risk",
      "timeline",
      "reconciliation_audit",
      "amount_precision",
      "reference_analysis",
      "raw_payload",
    ],
  })
  id: TransactionSectionId;

  @ApiProperty({ example: "Reconciliation audit trail" })
  label: string;

  @ApiProperty({
    example: "Every decision the reconciler made for this payment, newest first.",
    description: "Screen-reader friendly summary. Always populated.",
  })
  summary: string;

  @ApiProperty({ enum: ["critical", "warning", "info"] })
  risk: SectionRisk;

  @ApiProperty({
    enum: ["expanded", "collapsed"],
    description:
      "`expanded` sections carry `data`. Critical sections are always expanded.",
  })
  state: "expanded" | "collapsed";

  @ApiProperty({ enum: TransactionDetailTier })
  requiredTier: TransactionDetailTier;

  @ApiPropertyOptional({ description: "Section payload; absent when collapsed" })
  data?: unknown;
}

export class HiddenTransactionSectionDto {
  @ApiProperty()
  id: TransactionSectionId;

  @ApiProperty()
  label: string;

  @ApiProperty({ enum: ["critical", "warning", "info"] })
  risk: SectionRisk;

  @ApiProperty({ enum: TransactionDetailTier })
  requiredTier: TransactionDetailTier;

  @ApiProperty({
    example: "requires_advanced_tier",
    description:
      "Why the section is not in the response. Critical sections never appear here.",
  })
  reason: string;
}

export class TransactionWarningDto {
  @ApiProperty({
    enum: [
      "TRANSACTION_FAILED",
      "UNMATCHED_PAYMENT",
      "PARTIAL_PAYMENT",
      "AMOUNT_MISMATCH",
      "OVERPAYMENT",
      "MISSING_DESTINATION",
      "MISSING_AMOUNT",
      "UNVERIFIED_REFERENCE",
      "RAW_PAYLOAD_REDACTED",
    ],
  })
  code: TransactionWarningCode;

  @ApiProperty({ enum: ["critical", "warning", "info"] })
  severity: TransactionWarningSeverity;

  @ApiProperty({
    example: "This payment has not been matched to any invoice.",
  })
  message: string;

  @ApiPropertyOptional({
    example: "Review the destination account and payment reference before retrying.",
  })
  action?: string;

  @ApiProperty({
    example: true,
    description:
      "Always true. Critical warnings are returned at every detail tier and are never " +
      "confined to the advanced section.",
  })
  alwaysVisible: true;
}

export class DisclosureAccessibilityDto {
  @ApiProperty({ enum: ["progressive"] })
  disclosureModel: "progressive";

  @ApiProperty({ example: "Details expanded. Use the section heading to navigate its contents." })
  expandedAnnouncement: string;

  @ApiProperty({ example: "Details collapsed. Activate the control to reveal them." })
  collapsedAnnouncement: string;

  @ApiProperty({
    type: [String],
    description:
      "Recommended reading/tab order. Critical sections come first so risk is announced before detail.",
  })
  focusOrder: TransactionSectionId[];

  @ApiProperty({
    type: [String],
    description:
      "Sections a client must render expanded by default. Never render these behind a default-collapsed toggle.",
  })
  alwaysVisibleSections: TransactionSectionId[];
}

export class TransactionDisclosureDto {
  @ApiProperty({ enum: TransactionDetailTier })
  requestedTier: TransactionDetailTier;

  @ApiProperty({ enum: TransactionDetailTier })
  effectiveTier: TransactionDetailTier;

  @ApiProperty({ type: [String] })
  availableTiers: string[];

  @ApiProperty({ type: [TransactionSectionStateDto] })
  sections: TransactionSectionStateDto[];

  @ApiProperty({ type: [HiddenTransactionSectionDto] })
  hidden: HiddenTransactionSectionDto[];

  @ApiProperty({
    example: { critical: 1, warning: 0, info: 2 },
  })
  warningCounts: Record<TransactionWarningSeverity, number>;

  @ApiProperty({ type: DisclosureAccessibilityDto })
  accessibility: DisclosureAccessibilityDto;
}

export class TransactionDetailsResponseDto {
  @ApiProperty({ type: TransactionDisclosureDto })
  disclosure: TransactionDisclosureDto;

  @ApiProperty({
    type: [TransactionWarningDto],
    description:
      "Warnings for this transaction. Independent of the requested tier: a critical " +
      "warning is always present, even when every advanced section is collapsed.",
  })
  warnings: TransactionWarningDto[];
}
