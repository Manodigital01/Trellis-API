/**
 * Pure projection logic for progressive transaction detail disclosure.
 *
 * `buildTransactionDisclosure` is the single place that decides what a client
 * can see at a given tier, which keeps the "critical warnings are never
 * hidden" rule testable in isolation from any controller or database.
 *
 * Issue: #125
 */

import {
  DEFAULT_TRANSACTION_DETAIL_TIER,
  DisclosureAccessibility,
  HiddenSection,
  TransactionDetailInput,
  TransactionDetailTier,
  TransactionDisclosure,
  TransactionSectionDefinition,
  TransactionSectionId,
  TransactionSectionState,
  TransactionWarning,
  TransactionWarningSeverity,
  isTransactionDetailTier,
  tierRank,
} from "./transaction-detail.types";

const HIDDEN_REASON_REQUIRES_TIER = "requires_advanced_tier";
const HIDDEN_REASON_CRITICAL = "critical_risk_is_never_hidden";

function resolveTier(value: unknown): TransactionDetailTier {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TRANSACTION_DETAIL_TIER;
  }
  return isTransactionDetailTier(value) ? value : DEFAULT_TRANSACTION_DETAIL_TIER;
}

function warningCounts(
  warnings: TransactionWarning[],
): Record<TransactionWarningSeverity, number> {
  return {
    critical: warnings.filter((w) => w.severity === "critical").length,
    warning: warnings.filter((w) => w.severity === "warning").length,
    info: warnings.filter((w) => w.severity === "info").length,
  };
}

function buildAccessibility(
  sections: TransactionSectionState[],
): DisclosureAccessibility {
  return {
    disclosureModel: "progressive",
    expandedAnnouncement:
      "Details expanded. Use the section heading to navigate its contents.",
    collapsedAnnouncement:
      "Details collapsed. Activate the control to reveal them.",
    focusOrder: [...sections]
      .sort((a, b) => {
        if (a.risk !== b.risk) {
          if (a.risk === "critical") return -1;
          if (b.risk === "critical") return 1;
          if (a.risk === "warning") return -1;
          return 1;
        }
        return tierRank(a.requiredTier) - tierRank(b.requiredTier);
      })
      .map((section) => section.id),
    alwaysVisibleSections: sections
      .filter((section) => section.risk === "critical" || section.state === "expanded")
      .map((section) => section.id),
  };
}

/**
 * Builds the disclosure envelope for a transaction at the requested tier.
 *
 * Contract:
 * - Warnings are identical for every tier because they are built from the
 *   input before any tier filtering happens.
 * - Sections whose risk is `critical` are always `expanded`, whatever the tier.
 * - Collapsed sections expose no `data`.
 */
export function buildTransactionDisclosure(
  requestedTier: unknown,
  input: TransactionDetailInput,
): { disclosure: TransactionDisclosure; warnings: TransactionWarning[] } {
  const effectiveTier = resolveTier(requestedTier);

  const warnings: TransactionWarning[] = input.warnings.map((warning) => ({
    ...warning,
    // Critical warnings must be actionable; default the action rather than
    // leaving the client to invent one.
    action:
      warning.action ??
      (warning.severity === "critical"
        ? "Review this transaction before submitting or retrying the payment."
        : undefined),
    alwaysVisible: true as const,
  }));

  const sections: TransactionSectionState[] = [];
  const hidden: HiddenSection[] = [];

  for (const { definition, data } of input.sections) {
    const forcedByRisk = definition.risk === "critical";
    const expanded =
      forcedByRisk || tierRank(effectiveTier) >= tierRank(definition.requiredTier);

    if (expanded) {
      sections.push({
        id: definition.id,
        label: definition.label,
        summary: definition.summary,
        risk: definition.risk,
        state: "expanded",
        requiredTier: definition.requiredTier,
        data,
      });
      continue;
    }

    sections.push({
      id: definition.id,
      label: definition.label,
      summary: definition.summary,
      risk: definition.risk,
      state: "collapsed",
      requiredTier: definition.requiredTier,
    });
    hidden.push({
      id: definition.id,
      label: definition.label,
      risk: definition.risk,
      requiredTier: definition.requiredTier,
      reason: forcedByRisk ? HIDDEN_REASON_CRITICAL : HIDDEN_REASON_REQUIRES_TIER,
    });
  }

  const disclosure: TransactionDisclosure = {
    requestedTier: effectiveTier,
    effectiveTier,
    availableTiers: [TransactionDetailTier.SUMMARY, effectiveTier].filter(
      (tier, index, all) => all.indexOf(tier) === index,
    ) as TransactionDetailTier[],
    sections,
    hidden: hidden.filter((section) => section.reason === HIDDEN_REASON_REQUIRES_TIER),
    warningCounts: warningCounts(warnings),
    accessibility: buildAccessibility(sections),
  };

  assertDisclosureInvariants(disclosure, warnings);

  return { disclosure, warnings };
}

/**
 * Post-conditions the API guarantees. Kept as a runtime assertion (cheap, and
 * it fails loudly in production rather than silently leaking a section) and
 * covered directly by the unit tests.
 */
export function assertDisclosureInvariants(
  disclosure: TransactionDisclosure,
  warnings: TransactionWarning[],
): void {
  for (const warning of warnings) {
    if (warning.severity === "critical" && !warning.alwaysVisible) {
      throw new Error(
        `critical warning ${warning.code} must always be visible`,
      );
    }
  }
  for (const section of disclosure.sections) {
    if (section.state === "collapsed" && "data" in section && section.data !== undefined) {
      throw new Error(
        `collapsed section ${section.id} must not carry data`,
      );
    }
    if (section.risk === "critical" && section.state !== "expanded") {
      throw new Error(`critical section ${section.id} must always be expanded`);
    }
    if (!section.label || !section.summary) {
      throw new Error(
        `section ${section.id} must expose a label and a summary for assistive technology`,
      );
    }
  }
  for (const entry of disclosure.hidden) {
    if (entry.risk === "critical") {
      throw new Error(`critical section ${entry.id} must never be hidden`);
    }
    const section = disclosure.sections.find((s) => s.id === entry.id);
    if (section && section.state === "expanded") {
      throw new Error(`section ${entry.id} is reported as both hidden and expanded`);
    }
  }
}

/** Convenience helper: the sections a client receives expanded at a tier. */
export function expandedSectionIds(
  disclosure: TransactionDisclosure,
): TransactionSectionId[] {
  return disclosure.sections
    .filter((section) => section.state === "expanded")
    .map((section) => section.id);
}

/** Data of a single expanded section, or `undefined` when it is collapsed. */
export function sectionData<T = unknown>(
  disclosure: TransactionDisclosure,
  id: TransactionSectionId,
): T | undefined {
  const section = disclosure.sections.find((s) => s.id === id);
  if (!section || section.state !== "expanded") return undefined;
  return section.data as T;
}

/** True when the section exists and is expanded at the requested tier. */
export function isSectionExpanded(
  disclosure: TransactionDisclosure,
  id: TransactionSectionId,
): boolean {
  return disclosure.sections.some(
    (section) => section.id === id && section.state === "expanded",
  );
}

export type { TransactionSectionDefinition };
