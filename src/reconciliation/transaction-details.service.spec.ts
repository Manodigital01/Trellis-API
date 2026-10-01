/**
 * End-to-end behaviour of the tiered Stellar transaction view, including the
 * pre-submission (`dryRun`) path that makes advanced details available before
 * anything is written.
 *
 * Issue: #125
 */

import { ConfigService } from "@nestjs/config";
import {
  ReconciliationAudit,
  ReconciliationDecision,
} from "./entities/reconciliation-audit.entity";
import {
  ReconciliationInvoice,
  ReconciliationInvoiceStatus,
} from "./entities/reconciliation-invoice.entity";
import {
  StellarTransaction,
  StellarTransactionStatus,
} from "./entities/stellar-transaction.entity";
import { TransactionDetailsService } from "./transaction-details.service";
import { TransactionDetailTier } from "../common/transaction-details/transaction-detail.types";

const DESTINATION = "G".repeat(56);

function repository<T>() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((value: Partial<T>) => value as T),
    save: jest.fn(async (value: T) => value),
  };
}

function transaction(
  overrides: Partial<StellarTransaction> = {},
): StellarTransaction {
  return {
    transactionId: "tx-1",
    ledger: "12345",
    sourceAccount: "S".repeat(56),
    destinationAccount: DESTINATION,
    amount: "10.0000000",
    assetCode: "XLM",
    memo: "order-1",
    paymentReference: "order-1",
    status: StellarTransactionStatus.MATCHED,
    failureReason: null,
    observedAt: new Date("2026-09-01T10:00:00.000Z"),
    createdAt: new Date("2026-09-01T10:00:02.000Z"),
    rawPayload: { transaction_hash: "tx-1", amount: "10.0", fee_charged: "0.00001" },
    ...overrides,
  } as StellarTransaction;
}

function invoice(
  overrides: Partial<ReconciliationInvoice> = {},
): ReconciliationInvoice {
  return {
    invoiceId: "INV-1",
    expectedAmount: "10.0000000",
    paidAmount: "10.0000000",
    assetCode: "XLM",
    destinationAccount: DESTINATION,
    paymentReference: "order-1",
    status: ReconciliationInvoiceStatus.PAID,
    ...overrides,
  } as ReconciliationInvoice;
}

function audit(
  overrides: Partial<ReconciliationAudit> = {},
): ReconciliationAudit {
  return {
    id: "audit-1",
    invoiceId: "INV-1",
    transactionId: "tx-1",
    decision: ReconciliationDecision.MATCHED,
    reason: "Invoice fully paid",
    attempt: 0,
    metadata: null,
    createdAt: new Date("2026-09-01T10:00:02.000Z"),
    ...overrides,
  } as ReconciliationAudit;
}

describe("TransactionDetailsService", () => {
  const transactionRepo = repository<StellarTransaction>();
  const auditRepo = repository<ReconciliationAudit>();
  const invoiceRepo = repository<ReconciliationInvoice>();
  let service: TransactionDetailsService;

  beforeEach(() => {
    jest.clearAllMocks();
    transactionRepo.findOne.mockResolvedValue(transaction());
    auditRepo.find.mockResolvedValue([audit()]);
    invoiceRepo.findOne.mockResolvedValue(invoice());
    service = new TransactionDetailsService(
      transactionRepo as any,
      auditRepo as any,
      invoiceRepo as any,
      new ConfigService({ STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" }),
    );
  });

  describe("collapsed and expanded states", () => {
    it("collapses protocol plumbing at the summary tier", async () => {
      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);
      const states = Object.fromEntries(
        result!.disclosure.sections.map((s) => [s.id, s.state]),
      );

      expect(states.identity).toBe("expanded");
      expect(states.settlement).toBe("expanded");
      expect(states.risk).toBe("expanded");
      expect(states.timeline).toBe("collapsed");
      expect(states.reconciliation_audit).toBe("collapsed");
      expect(states.raw_payload).toBe("collapsed");
      expect(result!.disclosure.hidden.map((s) => s.id)).toEqual([
        "timeline",
        "reconciliation_audit",
        "amount_precision",
        "reference_analysis",
        "raw_payload",
      ]);
    });

    it("keeps the raw payload out of every tier below advanced", async () => {
      for (const tier of [
        TransactionDetailTier.SUMMARY,
        TransactionDetailTier.STANDARD,
      ]) {
        const result = await service.describe("tx-1", tier);
        const raw = result!.disclosure.sections.find((s) => s.id === "raw_payload");
        expect(raw?.state).toBe("collapsed");
        expect(raw?.data).toBeUndefined();
      }
    });

    it("expands the raw payload, amount precision and reference analysis at the advanced tier", async () => {
      const result = await service.describe("tx-1", TransactionDetailTier.ADVANCED);
      const states = Object.fromEntries(
        result!.disclosure.sections.map((s) => [s.id, s.data]),
      );

      expect(states.raw_payload).toEqual({
        transaction_hash: "tx-1",
        amount: "10.0",
        fee_charged: "0.00001",
      });
      expect(states.amount_precision).toMatchObject({
        decimalScale: 7,
        rawAmount: "10.0000000",
      });
      expect(states.reference_analysis).toMatchObject({
        referenceMatches: true,
        destinationMatches: true,
        assetMatches: true,
      });
      expect(result!.disclosure.hidden).toEqual([]);
    });

    it("adds the audit trail at the standard tier", async () => {
      const result = await service.describe("tx-1", TransactionDetailTier.STANDARD);
      const audits = result!.disclosure.sections.find(
        (s) => s.id === "reconciliation_audit",
      );

      expect(audits?.state).toBe("expanded");
      expect(audits?.data).toEqual([
        expect.objectContaining({ decision: ReconciliationDecision.MATCHED }),
      ]);
    });
  });

  describe("critical warnings are never hidden", () => {
    it("flags an unmatched payment at the summary tier", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({ status: StellarTransactionStatus.UNMATCHED }),
      );

      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);

      expect(result!.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "UNMATCHED_PAYMENT",
            severity: "critical",
            alwaysVisible: true,
          }),
        ]),
      );
      expect(
        result!.disclosure.sections.find((s) => s.id === "risk")?.state,
      ).toBe("expanded");
      expect(
        result!.disclosure.hidden.some((s) => s.risk === "critical"),
      ).toBe(false);
    });

    it("flags a failed payment with the recorded failure reason", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({
          status: StellarTransactionStatus.FAILED,
          failureReason: "Horizon returned HTTP 503",
        }),
      );

      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);
      const failed = result!.warnings.find(
        (w) => w.code === "TRANSACTION_FAILED",
      );

      expect(failed?.severity).toBe("critical");
      expect(failed?.message).toBe("Horizon returned HTTP 503");
      expect(failed?.action).toMatch(/manually/i);
    });

    it("returns the same critical warnings regardless of tier", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({ status: StellarTransactionStatus.UNMATCHED }),
      );

      const criticalCodes = await Promise.all(
        [
          TransactionDetailTier.SUMMARY,
          TransactionDetailTier.STANDARD,
          TransactionDetailTier.ADVANCED,
        ].map(async (tier) => {
          const result = await service.describe("tx-1", tier);
          return result!.warnings
            .filter((w) => w.severity === "critical")
            .map((w) => w.code);
        }),
      );

      expect(criticalCodes[0]).toEqual(criticalCodes[1]);
      expect(criticalCodes[1]).toEqual(criticalCodes[2]);
    });

    it("warns about a partial payment without escalating it to critical", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({ status: StellarTransactionStatus.PARTIAL }),
      );
      invoiceRepo.findOne.mockResolvedValue(
        invoice({
          expectedAmount: "25.0000000",
          paidAmount: "10.0000000",
          status: ReconciliationInvoiceStatus.PARTIAL,
        }),
      );

      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);
      const partial = result!.warnings.find((w) => w.code === "PARTIAL_PAYMENT");

      expect(partial?.severity).toBe("warning");
      expect(result!.warnings.some((w) => w.severity === "critical")).toBe(false);
    });

    it("warns when no invoice exists for the destination", async () => {
      invoiceRepo.findOne.mockResolvedValue(null);

      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);

      expect(result!.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "MISSING_DESTINATION" }),
        ]),
      );
    });

    it("warns when the reference cannot be verified because the memo is absent", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({ memo: null, paymentReference: undefined }),
      );

      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);

      expect(result!.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "UNVERIFIED_REFERENCE" }),
        ]),
      );
    });

    it("flags an overpayment against the expected amount", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({ amount: "12.5000000" }),
      );

      const result = await service.describe("tx-1", TransactionDetailTier.SUMMARY);
      const overpaid = result!.warnings.find((w) => w.code === "OVERPAYMENT");

      expect(overpaid?.message).toContain("12.5000000");
      expect(overpaid?.message).toContain("2.5000000");
    });
  });

  describe("advanced details before submission", () => {
    it("returns null when the transaction does not exist", async () => {
      transactionRepo.findOne.mockResolvedValue(null);

      await expect(service.describe("missing", TransactionDetailTier.SUMMARY)).resolves.toBeNull();
    });

    it("projects the full advanced view without writing anything", async () => {
      transactionRepo.findOne.mockResolvedValue(null);

      const result = await service.preview(
        {
          transactionId: "tx-new",
          destinationAccount: DESTINATION,
          amount: "10.0000000",
          memo: "order-1",
        },
        TransactionDetailTier.ADVANCED,
      );

      expect(result.preview).toMatchObject({
        dryRun: true,
        persisted: false,
        wouldCreate: true,
        duplicate: false,
      });
      expect(result.preview.expandedSections).toContain("raw_payload");
      expect(transactionRepo.save).not.toHaveBeenCalled();
      expect(invoiceRepo.save).not.toHaveBeenCalled();
      expect(auditRepo.save).not.toHaveBeenCalled();
    });

    it("surfaces the critical risks of an unsaved payment at the summary tier", async () => {
      transactionRepo.findOne.mockResolvedValue(null);
      invoiceRepo.findOne.mockResolvedValue(invoice({ paymentReference: "order-9" }));

      const result = await service.preview(
        {
          transactionId: "tx-new",
          destinationAccount: DESTINATION,
          amount: "3.0000000",
          memo: "order-1",
        },
        TransactionDetailTier.SUMMARY,
      );

      expect(result.warnings.some((w) => w.code === "UNMATCHED_PAYMENT")).toBe(true);
      expect(
        result.disclosure.sections.find((s) => s.id === "raw_payload")?.state,
      ).toBe("collapsed");
    });

    it("flags a duplicate submission before it is written", async () => {
      transactionRepo.findOne.mockResolvedValue(
        transaction({ status: StellarTransactionStatus.MATCHED }),
      );

      const result = await service.preview(
        {
          transactionId: "tx-1",
          destinationAccount: DESTINATION,
          amount: "10.0000000",
        },
        TransactionDetailTier.ADVANCED,
      );

      expect(result.preview).toMatchObject({
        duplicate: true,
        wouldCreate: false,
      });
      expect(transactionRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("accessibility contract exposed to clients", () => {
    it("labels every section and orders the focus with risk first", async () => {
      const result = await service.describe("tx-1", TransactionDetailTier.ADVANCED);

      for (const section of result!.disclosure.sections) {
        expect(section.label).toBeTruthy();
        expect(section.summary).toBeTruthy();
      }
      expect(result!.disclosure.accessibility.focusOrder[0]).toBe("risk");
      expect(result!.disclosure.accessibility.disclosureModel).toBe("progressive");
      expect(result!.disclosure.accessibility.alwaysVisibleSections).toContain(
        "risk",
      );
    });
  });
});
