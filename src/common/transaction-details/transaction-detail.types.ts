/**
 * Progressive disclosure contract for transaction details.
 *
 * Trellis clients need two things that pull in opposite directions: a default
 * view that stays readable, and access to the raw protocol material a support
 * engineer needs when a payment goes wrong. This module encodes both as an
 * explicit, versioned contract so any client (web, mobile, CLI, SDK) can
 * implement the same collapsed/expanded behaviour and so the API can prove
 * that risk information is never hidden behind an "advanced" toggle.
 *
 * Design rules enforced here:
 *   1. Warnings are computed from the data *before* the tier is applied, so a
 *      client cannot reach a state where a critical warning is invisible.
 *   2. A section whose risk is `critical` is always `expanded`, and is never
 *      listed in `hidden`.
 *   3. Collapsed sections never carry payload data — only a label, a summary
 *      and the tier required to expand them.
 *
 * Issue: #125
 */

/** Detail tiers, ordered from least to most detail. */
export enum TransactionDetailTier {
  SUMMARY = "summary",
  STANDARD = "standard",
  ADVANCED = "advanced",
}

export const TRANSACTION_DETAIL_TIERS: TransactionDetailTier[] = [
  TransactionDetailTier.SUMMARY,
  TransactionDetailTier.STANDARD,
  TransactionDetailTier.ADVANCED,
];

export const DEFAULT_TRANSACTION_DETAIL_TIER = TransactionDetailTier.STANDARD;

export function isTransactionDetailTier(
  value: unknown,
): value is TransactionDetailTier {
  return (
    typeof value === "string" &&
    TRANSACTION_DETAIL_TIERS.includes(value as TransactionDetailTier)
  );
}

/** Numeric ordering used to decide whether a section is expanded. */
export function tierRank(tier: TransactionDetailTier): number {
  return TRANSACTION_DETAIL_TIERS.indexOf(tier);
}

export type SectionState = "expanded" | "collapsed";

/** How much a section matters to a user who does not expand it. */
export type SectionRisk = "critical" | "warning" | "info";

/** Stable machine-readable identifiers so clients can assert on them. */
export type TransactionSectionId =
  | "identity"
  | "settlement"
  | "risk"
  | "timeline"
  | "reconciliation_audit"
  | "amount_precision"
  | "reference_analysis"
  | "raw_payload";

export interface TransactionSectionDefinition {
  id: TransactionSectionId;
  label: string;
  /** Screen-reader friendly one-liner, always populated. */
  summary: string;
  risk: SectionRisk;
  requiredTier: TransactionDetailTier;
}

export interface TransactionSectionState {
  id: TransactionSectionId;
  label: string;
  summary: string;
  risk: SectionRisk;
  state: SectionState;
  requiredTier: TransactionDetailTier;
  /** Only present when `state === "expanded"`. */
  data?: unknown;
}

export interface HiddenSection {
  id: TransactionSectionId;
  label: string;
  risk: SectionRisk;
  requiredTier: TransactionDetailTier;
  /** Machine-readable explanation, e.g. `requires_advanced_tier`. */
  reason: string;
}

export type TransactionWarningCode =
  | "TRANSACTION_FAILED"
  | "UNMATCHED_PAYMENT"
  | "PARTIAL_PAYMENT"
  | "AMOUNT_MISMATCH"
  | "OVERPAYMENT"
  | "MISSING_DESTINATION"
  | "MISSING_AMOUNT"
  | "UNVERIFIED_REFERENCE"
  | "RAW_PAYLOAD_REDACTED";

export type TransactionWarningSeverity = "critical" | "warning" | "info";

export interface TransactionWarning {
  code: TransactionWarningCode;
  severity: TransactionWarningSeverity;
  message: string;
  /** Action the user can take. Never omitted for `critical` warnings. */
  action?: string;
  /**
   * Always `true`. Present so a client can assert the contract: critical risk
   * information is never confined to the advanced tier.
   */
  alwaysVisible: true;
}

export interface DisclosureAccessibility {
  /**
   * `progressive` means sections are revealed by the client, not fetched from
   * a second endpoint. Implementations should expose an `aria-expanded`
   * control per section.
   */
  disclosureModel: "progressive";
  /** Text a client should announce when a section expands. */
  expandedAnnouncement: string;
  /** Text a client should announce when a section collapses. */
  collapsedAnnouncement: string;
  /** Recommended tab/reading order: critical first, then by tier. */
  focusOrder: TransactionSectionId[];
  /** Sections a client must never render behind a default-collapsed toggle. */
  alwaysVisibleSections: TransactionSectionId[];
}

export interface TransactionDisclosure {
  requestedTier: TransactionDetailTier;
  effectiveTier: TransactionDetailTier;
  availableTiers: TransactionDetailTier[];
  sections: TransactionSectionState[];
  hidden: HiddenSection[];
  warningCounts: Record<TransactionWarningSeverity, number>;
  accessibility: DisclosureAccessibility;
}

/** Input contract every domain projection has to provide. */
export interface TransactionDetailInput {
  sections: Array<{
    definition: TransactionSectionDefinition;
    data: unknown;
  }>;
  warnings: Array<Omit<TransactionWarning, "alwaysVisible">>;
}
