/**
 * Fault injection for the reconciliation pipeline.
 *
 * The interesting question is not "does it throw" but "what is left behind
 * afterwards": a half-applied invoice, a cursor advanced past a payment that was
 * never stored, or a retry that pays an invoice twice.
 *
 * Every peer here is a double. No network, no database, no wall-clock waiting:
 * the retry backoff is asserted in virtual time.
 *
 * Issue: #127
 */

import { ConfigService } from "@nestjs/config";
import { ReconciliationService } from "./reconciliation.service";
import { ReconciliationInvoiceStatus } from "./entities/reconciliation-invoice.entity";
import { StellarTransactionStatus } from "./entities/stellar-transaction.entity";
import { ReconciliationDecision } from "./entities/reconciliation-audit.entity";
import {
  FaultController,
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
  createFaultyFetch,
} from "../testing/fault-injection/fault-injection";

const ACCOUNT = "G".repeat(56);
const DESTINATION = "G".repeat(55);
const REFERENCE = "order-1";

type Invoice = {
  id?: string;
  invoiceId: string;
  expectedAmount: string;
  paidAmount: string;
  assetCode: string;
  destinationAccount: string;
  paymentReference: string;
  status: string;
};

type Transaction = {
  id?: string;
  transactionId: string;
  destinationAccount: string;
  amount: string;
  assetCode: string;
  paymentReference?: string;
  status: string;
  failureReason?: string | null;
};

type Audit = {
  id?: string;
  invoiceId?: string;
  transactionId?: string;
  decision: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

function paymentRecord(hash: string, amount = "10.0") {
  return {
    type: "payment",
    transaction_hash: hash,
    ledger: 12345,
    from: "S".repeat(56),
    to: DESTINATION,
    amount,
    asset_type: "native",
    memo: REFERENCE,
    paging_token: `cursor-${hash}`,
  };
}

describe("reconciliation fault injection", () => {
  const clock = new ManualClock();
  let horizon: FaultController;
  let invoiceDb: FaultController;
  let transactionDb: FaultController;
  let auditDb: FaultController;
  let invoices: FaultyRepository<Invoice>;
  let transactions: FaultyRepository<Transaction>;
  let audits: FaultyRepository<Audit>;
  let ledger: SideEffectLedger;
  let service: ReconciliationService;
  let realFetch: typeof global.fetch;

  beforeEach(() => {
    horizon = new FaultController("Horizon");
    invoiceDb = new FaultController("PostgreSQL invoices");
    transactionDb = new FaultController("PostgreSQL transactions");
    auditDb = new FaultController("PostgreSQL audit log");
    invoices = new FaultyRepository<Invoice>(invoiceDb, () => ({
      invoiceId: "INV-1",
      expectedAmount: "10.0000000",
      paidAmount: "0.0000000",
      assetCode: "XLM",
      destinationAccount: DESTINATION,
      paymentReference: REFERENCE,
      status: ReconciliationInvoiceStatus.OPEN,
    }));
    transactions = new FaultyRepository<Transaction>(transactionDb, () => ({
      transactionId: "tx-1",
      destinationAccount: DESTINATION,
      amount: "10.0000000",
      assetCode: "XLM",
      paymentReference: REFERENCE,
      status: StellarTransactionStatus.UNMATCHED,
    }));
    audits = new FaultyRepository<Audit>(auditDb, () => ({
      decision: ReconciliationDecision.MATCHED,
    }));
    ledger = new SideEffectLedger(clock);
    realFetch = global.fetch;
    service = new ReconciliationService(
      invoices as never,
      transactions as never,
      audits as never,
      new ConfigService({
        STELLAR_RECONCILIATION_ACCOUNT: ACCOUNT,
        STELLAR_HORIZON_URL: "https://horizon.example",
      }),
    );
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function withHorizon(body: unknown) {
    global.fetch = createFaultyFetch(horizon, {
      defaultBody: { _embedded: { records: [body] } },
    }) as typeof global.fetch;
  }

  describe("network failures", () => {
    it("records an actionable retry audit when Horizon times out", async () => {
      horizon.queueTimeout();
      global.fetch = createFaultyFetch(horizon) as typeof global.fetch;

      const result = await service.pollHorizon();

      expect(result).toEqual({ ingested: 0 });
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0]).toMatchObject({
        decision: ReconciliationDecision.RETRY,
        reason: "Horizon did not answer before the timeout elapsed",
        metadata: { source: "horizon", retryable: true },
      });
      // Nothing was stored, so a later poll can safely repeat the work.
      expect(transactions.rows).toEqual([]);
    });

    it("surfaces a connection reset without storing a partial payment", async () => {
      horizon.queueFault({ kind: "connection-reset" });
      global.fetch = createFaultyFetch(horizon) as typeof global.fetch;

      await service.pollHorizon();

      expect(transactions.rows).toEqual([]);
      expect(audits.rows[0].reason).toMatch(/reset the connection/);
    });

    it("does not advance the cursor past a payment it could not read", async () => {
      horizon.queueMalformedBody();
      global.fetch = createFaultyFetch(horizon) as typeof global.fetch;

      await service.pollHorizon();
      // A second poll must ask Horizon again rather than skip the record.
      withHorizon(paymentRecord("tx-1"));
      const second = await service.pollHorizon();

      expect(second.ingested).toBe(1);
      expect(horizon.attemptsFor("fetch")).toBe(2);
    });

    it("refuses a body of the wrong shape rather than skipping every payment", async () => {
      horizon.queueMalformedPayload({ _embedded: { records: "not-an-array" } });
      global.fetch = createFaultyFetch(horizon) as typeof global.fetch;

      const result = await service.pollHorizon();

      expect(result).toEqual({ ingested: 0 });
      expect(audits.rows[0]).toMatchObject({
        decision: ReconciliationDecision.RETRY,
        reason:
          "Horizon returned a payment list that is not an array; refusing to advance the cursor",
      });
    });

    it("skips a record that is not a payment and keeps the cursor moving", async () => {
      withHorizon({
        ...paymentRecord("tx-1"),
        type: "account_creation",
        paging_token: "cursor-1",
      });

      const result = await service.pollHorizon();

      expect(result.ingested).toBe(0);
      expect(transactions.rows).toEqual([]);
    });

    it("does nothing when reconciliation is not configured", async () => {
      const unconfigured = new ReconciliationService(
        invoices as never,
        transactions as never,
        audits as never,
        new ConfigService({}),
      );

      await expect(unconfigured.pollHorizon()).resolves.toEqual({
        skipped: true,
        ingested: 0,
      });
    });
  });

  describe("persistence failures", () => {
    it("marks the transaction failed with the reason the database gave", async () => {
      // The audit write inside reconcileTransaction is what breaks.
      auditDb.queueConstraintViolation();

      const result = await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });

      expect(result.status).toBe(StellarTransactionStatus.FAILED);
      expect(result.failureReason).toMatch(/constraint was violated/);
      expect(
        audits.rows.some(
          (row) => row.decision === ReconciliationDecision.FAILED,
        ),
      ).toBe(true);
    });

    it("leaves the invoice untouched when the transaction write breaks", async () => {
      await invoices.save(invoices.create({ id: "invoice-1" }));
      transactionDb.queueConstraintViolation();

      await expect(
        service.ingestTransaction({
          transactionId: "tx-1",
          destinationAccount: DESTINATION,
          amount: "10.0",
          memo: REFERENCE,
        }),
      ).rejects.toThrow(/constraint was violated/);

      // The payment never reached the invoice, and no audit claims otherwise.
      expect(invoices.rows[0].paidAmount).toBe("0.0000000");
      expect(invoices.rows[0].status).toBe(ReconciliationInvoiceStatus.OPEN);
      expect(audits.rows).toEqual([]);
    });

    it("shows a half-written audit row and an actionable failure reason", async () => {
      await invoices.save(invoices.create({ id: "invoice-1" }));
      auditDb.queuePartialWrite();

      const result = await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });

      expect(result.status).toBe(StellarTransactionStatus.FAILED);
      expect(result.failureReason).toMatch(/accepted part of the write/);
      // The audit row landed with only its keys, so the row is visible to an
      // operator instead of vanishing.
      expect(audits.rows[0]).toEqual({
        id: "row-1",
        invoiceId: "INV-1",
        transactionId: "tx-1",
      });
      expect(audits.rows[1]).toMatchObject({
        decision: ReconciliationDecision.FAILED,
      });
    });

    it("applies the payment exactly once when the audit write breaks", async () => {
      await invoices.save(invoices.create({ id: "invoice-1" }));
      auditDb.queuePartialWrite();

      await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });

      expect(invoices.rows[0].paidAmount).toBe("10.0000000");
      expect(invoices.rows[0].status).toBe(ReconciliationInvoiceStatus.PAID);
      ledger.record("payment", "tx-1");
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("keeps the invoice consistent when a payment is ingested twice", async () => {
      await invoices.save(invoices.create({ id: "invoice-1" }));
      const first = await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });
      const second = await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });

      expect(first.status).toBe(StellarTransactionStatus.MATCHED);
      expect(second.id).toBe(first.id);
      expect(invoices.rows[0].paidAmount).toBe("10.0000000");
      ledger.record("payment", "tx-1");
      expect(ledger.count("tx-1")).toBe(1);
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("does not double-count a payment when the final write fails", async () => {
      await invoices.save(invoices.create({ id: "invoice-1" }));
      // The payment is applied, then the closing transaction save fails: the
      // worst case for a retry, because re-running would pay twice.
      transactionDb.queueFault({ kind: "constraint-violation", onCall: 2 });

      await expect(
        service.ingestTransaction({
          transactionId: "tx-1",
          destinationAccount: DESTINATION,
          amount: "10.0",
          memo: REFERENCE,
        }),
      ).rejects.toThrow(/constraint was violated/);

      // The operator retries; the stored transaction id stops the second
      // application.
      const retried = await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });

      expect(retried.transactionId).toBe("tx-1");
      expect(invoices.rows[0].paidAmount).toBe("10.0000000");
      ledger.record("payment", "tx-1", { attempts: 2 });
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  describe("retries", () => {
    it("is safe to re-poll after a failure and still pays the invoice once", async () => {
      await invoices.save(invoices.create({ id: "invoice-1" }));
      horizon.queueTimeout();
      global.fetch = createFaultyFetch(horizon) as typeof global.fetch;
      await service.pollHorizon();

      withHorizon(paymentRecord("tx-1"));
      const retried = await service.pollHorizon();
      // A third poll must not pay again: the transaction id is now known.
      withHorizon(paymentRecord("tx-1"));
      const again = await service.pollHorizon();

      expect(retried.ingested).toBe(1);
      expect(again.ingested).toBe(1);
      expect(invoices.rows[0].paidAmount).toBe("10.0000000");
      ledger.record("payment", "tx-1", { polls: 2 });
      expect(() => ledger.assertNoDuplicates()).not.toThrow();
    });

    it("records why a duplicate transaction event was ignored", async () => {
      await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });
      const auditsBefore = audits.rows.length;

      await service.ingestTransaction({
        transactionId: "tx-1",
        destinationAccount: DESTINATION,
        amount: "10.0",
        memo: REFERENCE,
      });

      expect(audits.rows).toHaveLength(auditsBefore + 1);
      expect(audits.rows[auditsBefore]).toMatchObject({
        decision: ReconciliationDecision.RETRY,
        reason: "Duplicate transaction event ignored",
        metadata: { idempotent: true },
      });
    });
  });

  describe("error messages", () => {
    it("names the invalid amount rather than throwing a bare type error", async () => {
      await expect(
        service.ingestTransaction({
          transactionId: "tx-1",
          destinationAccount: DESTINATION,
          amount: "ten dollars",
          memo: REFERENCE,
        }),
      ).rejects.toThrow("Invalid Stellar amount: ten dollars");
    });

    it("reports a missing transaction as not found", async () => {
      await expect(service.getTransaction("missing")).rejects.toThrow(
        "Stellar transaction missing not found",
      );
    });

    it("reports a missing invoice as not found", async () => {
      await expect(service.getInvoice("missing")).rejects.toThrow(
        "Invoice missing not found",
      );
    });
  });
});
