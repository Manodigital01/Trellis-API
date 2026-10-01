/**
 * Progressive disclosure contract tests.
 *
 * Covers the collapsed/expanded states and the accessibility guarantees the
 * API makes to any client (web, mobile, SDK) that renders the disclosure
 * envelope. These are the "UI checks" for issue #125: there is no frontend in
 * this repository, so the renderable contract itself is asserted.
 *
 * Issue: #125
 */

import {
  assertDisclosureInvariants,
  buildTransactionDisclosure,
  expandedSectionIds,
  isSectionExpanded,
  sectionData,
} from "./transaction-detail.projection";
import {
  DEFAULT_TRANSACTION_DETAIL_TIER,
  TransactionDetailInput,
  TransactionDetailTier,
  TransactionSectionDefinition,
  TransactionWarningCode,
  isTransactionDetailTier,
  tierRank,
} from "./transaction-detail.types";

const sections: TransactionSectionDefinition[] = [
  {
    id: "identity",
    label: "Payment identity",
    summary: "Transaction hash, ledger, sender, recipient, amount and asset.",
    risk: "info",
    requiredTier: TransactionDetailTier.SUMMARY,
  },
  {
    id: "settlement",
    label: "Settlement status",
    summary: "Whether the payment is matched, partial, unmatched or failed.",
    risk: "warning",
    requiredTier: TransactionDetailTier.SUMMARY,
  },
  {
    id: "risk",
    label: "Risk signals",
    summary: "Critical and warning level risks detected for this payment.",
    risk: "critical",
    requiredTier: TransactionDetailTier.ADVANCED,
  },
  {
    id: "reconciliation_audit",
    label: "Reconciliation audit trail",
    summary: "Every decision the reconciler made for this payment.",
    risk: "info",
    requiredTier: TransactionDetailTier.STANDARD,
  },
  {
    id: "raw_payload",
    label: "Raw protocol payload",
    summary: "The unedited Horizon record for this payment.",
    risk: "info",
    requiredTier: TransactionDetailTier.ADVANCED,
  },
];

function input(
  warnings: Array<{ code: TransactionWarningCode; severity: "critical" | "warning" | "info"; message: string }> = [],
): TransactionDetailInput {
  return {
    warnings,
    sections: sections.map((definition) => ({
      definition,
      data: { section: definition.id },
    })),
  };
}

describe("transaction detail tiers", () => {
  it("orders tiers summary < standard < advanced", () => {
    expect(tierRank(TransactionDetailTier.SUMMARY)).toBeLessThan(
      tierRank(TransactionDetailTier.STANDARD),
    );
    expect(tierRank(TransactionDetailTier.STANDARD)).toBeLessThan(
      tierRank(TransactionDetailTier.ADVANCED),
    );
  });

  it("falls back to the standard tier for missing or unknown values", () => {
    expect(DEFAULT_TRANSACTION_DETAIL_TIER).toBe(TransactionDetailTier.STANDARD);
    expect(isTransactionDetailTier("advanced")).toBe(true);
    expect(isTransactionDetailTier("verbose")).toBe(false);
  });

  it("defaults to standard when the query parameter is absent", () => {
    const { disclosure } = buildTransactionDisclosure(undefined, input());
    expect(disclosure.effectiveTier).toBe(TransactionDetailTier.STANDARD);
  });
});

describe("progressive disclosure", () => {
  it("expands summary sections and collapses the rest at the summary tier", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input(),
    );

    expect(expandedSectionIds(disclosure)).toEqual(["identity", "settlement", "risk"]);
    expect(disclosure.hidden.map((s) => s.id)).toEqual([
      "reconciliation_audit",
      "raw_payload",
    ]);
  });

  it("adds the audit trail at the standard tier", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.STANDARD,
      input(),
    );

    expect(isSectionExpanded(disclosure, "reconciliation_audit")).toBe(true);
    expect(isSectionExpanded(disclosure, "raw_payload")).toBe(false);
  });

  it("unlocks every section at the advanced tier", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.ADVANCED,
      input(),
    );

    expect(disclosure.hidden).toEqual([]);
    for (const section of disclosure.sections) {
      expect(section.state).toBe("expanded");
    }
  });

  it("keeps section data out of a collapsed section", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input(),
    );

    const collapsed = disclosure.sections.find(
      (s) => s.id === "raw_payload",
    );
    expect(collapsed?.state).toBe("collapsed");
    expect(collapsed?.data).toBeUndefined();
    expect(sectionData(disclosure, "raw_payload")).toBeUndefined();
  });

  it("exposes data for expanded sections", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.ADVANCED,
      input(),
    );

    expect(sectionData(disclosure, "identity")).toEqual({ section: "identity" });
  });
});

describe("critical risk is never hidden", () => {
  it("expands a critical section even at the summary tier", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input(),
    );

    expect(isSectionExpanded(disclosure, "risk")).toBe(true);
  });

  it("never lists a critical section as hidden", () => {
    for (const tier of [
      TransactionDetailTier.SUMMARY,
      TransactionDetailTier.STANDARD,
      TransactionDetailTier.ADVANCED,
    ]) {
      const { disclosure } = buildTransactionDisclosure(tier, input());
      expect(disclosure.hidden.some((s) => s.risk === "critical")).toBe(false);
    }
  });

  it("returns identical critical warnings at every tier", () => {
    const criticals = [
      { code: "UNMATCHED_PAYMENT" as const, severity: "critical" as const, message: "unmatched" },
      { code: "PARTIAL_PAYMENT" as const, severity: "warning" as const, message: "partial" },
    ];

    const summaries = [
      TransactionDetailTier.SUMMARY,
      TransactionDetailTier.STANDARD,
      TransactionDetailTier.ADVANCED,
    ].map((tier) => {
      const { warnings } = buildTransactionDisclosure(tier, input(criticals));
      return warnings.filter((w) => w.severity === "critical");
    });

    expect(summaries[0]).toEqual(summaries[1]);
    expect(summaries[1]).toEqual(summaries[2]);
    expect(summaries[0]).toHaveLength(1);
    expect(summaries[0][0].alwaysVisible).toBe(true);
  });

  it("counts warnings per severity so a client can announce them", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input([
        { code: "UNMATCHED_PAYMENT", severity: "critical", message: "a" },
        { code: "OVERPAYMENT", severity: "warning", message: "b" },
        { code: "AMOUNT_MISMATCH", severity: "info", message: "c" },
      ]),
    );

    expect(disclosure.warningCounts).toEqual({ critical: 1, warning: 1, info: 1 });
  });

  it("gives every critical warning a default action", () => {
    const { warnings } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input([{ code: "UNMATCHED_PAYMENT", severity: "critical", message: "a" }]),
    );

    expect(warnings[0].action).toMatch(/before submitting or retrying/i);
  });
});

describe("accessibility contract", () => {
  it("gives every section a label and a screen-reader summary", () => {
    for (const tier of [
      TransactionDetailTier.SUMMARY,
      TransactionDetailTier.STANDARD,
      TransactionDetailTier.ADVANCED,
    ]) {
      const { disclosure } = buildTransactionDisclosure(tier, input());
      for (const section of disclosure.sections) {
        expect(section.label.length).toBeGreaterThan(0);
        expect(section.summary.length).toBeGreaterThan(0);
        expect(section.summary).toMatch(/\.$/);
      }
    }
  });

  it("declares a progressive disclosure model with announcement text", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.STANDARD,
      input(),
    );

    expect(disclosure.accessibility.disclosureModel).toBe("progressive");
    expect(disclosure.accessibility.expandedAnnouncement).toMatch(/expanded/i);
    expect(disclosure.accessibility.collapsedAnnouncement).toMatch(/collapsed/i);
  });

  it("puts critical sections first in the reading order", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input(),
    );

    expect(disclosure.accessibility.focusOrder[0]).toBe("risk");
  });

  it("lists every expanded or critical section as always visible", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.SUMMARY,
      input(),
    );

    const alwaysVisible = disclosure.accessibility.alwaysVisibleSections;
    expect(alwaysVisible).toContain("risk");
    expect(alwaysVisible).toContain("identity");
    expect(alwaysVisible).not.toContain("raw_payload");
  });

  it("assigns every section a unique id", () => {
    const { disclosure } = buildTransactionDisclosure(
      TransactionDetailTier.ADVANCED,
      input(),
    );
    const ids = disclosure.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("disclosure invariants", () => {
  const baseDisclosure = () =>
    buildTransactionDisclosure(TransactionDetailTier.SUMMARY, input()).disclosure;

  it("rejects a critical warning that is not marked always visible", () => {
    expect(() =>
      assertDisclosureInvariants(baseDisclosure(), [
        {
          code: "UNMATCHED_PAYMENT",
          severity: "critical",
          message: "a",
          alwaysVisible: false as unknown as true,
        },
      ]),
    ).toThrow(/must always be visible/);
  });

  it("rejects a collapsed section that still carries data", () => {
    const disclosure = baseDisclosure();
    const collapsed = disclosure.sections.find((s) => s.state === "collapsed");
    expect(collapsed).toBeDefined();

    expect(() =>
      assertDisclosureInvariants(
        {
          ...disclosure,
          sections: disclosure.sections.map((s) =>
            s.id === collapsed!.id ? { ...s, data: { leaked: true } } : s,
          ),
        },
        [],
      ),
    ).toThrow(/must not carry data/);
  });

  it("rejects a critical section that is not expanded", () => {
    const disclosure = baseDisclosure();

    expect(() =>
      assertDisclosureInvariants(
        {
          ...disclosure,
          sections: disclosure.sections.map((s) =>
            s.id === "risk"
              ? { ...s, state: "collapsed" as const, data: undefined }
              : s,
          ),
        },
        [],
      ),
    ).toThrow(/must always be expanded/);
  });

  it("rejects a critical section listed as hidden", () => {
    const disclosure = baseDisclosure();

    expect(() =>
      assertDisclosureInvariants(
        {
          ...disclosure,
          hidden: [
            {
              id: "risk" as const,
              label: "Risk signals",
              risk: "critical" as const,
              requiredTier: TransactionDetailTier.SUMMARY,
              reason: "requires_advanced_tier",
            },
          ],
        },
        [],
      ),
    ).toThrow(/must never be hidden/);
  });

  it("rejects a section without assistive-technology text", () => {
    const disclosure = baseDisclosure();

    expect(() =>
      assertDisclosureInvariants(
        {
          ...disclosure,
          sections: disclosure.sections.map((s, index) =>
            index === 0 ? { ...s, label: "" } : s,
          ),
        },
        [],
      ),
    ).toThrow(/label and a summary/);
  });

  it("cannot be violated through the public builder", () => {
    for (const tier of [
      TransactionDetailTier.SUMMARY,
      TransactionDetailTier.STANDARD,
      TransactionDetailTier.ADVANCED,
    ]) {
      const { disclosure, warnings } = buildTransactionDisclosure(
        tier,
        input([
          { code: "UNMATCHED_PAYMENT", severity: "critical", message: "a" },
        ]),
      );
      expect(() => assertDisclosureInvariants(disclosure, warnings)).not.toThrow();
    }
  });
});
