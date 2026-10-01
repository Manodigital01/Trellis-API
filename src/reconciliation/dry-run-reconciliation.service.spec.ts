import {
  ReconciliationInvoice,
  ReconciliationInvoiceStatus,
} from "./entities/reconciliation-invoice.entity";
import {
  StellarTransaction,
  StellarTransactionStatus,
} from "./entities/stellar-transaction.entity";
import {
  DryRunReconciliationService,
  ReconciliationFindingType,
  ReconciliationSeverity,
  UserBalanceProvider,
} from "./dry-run-reconciliation.service";

const DEST = "GDESTINATIONACCOUNT0000000000000000000000000000000000";
const OTHER_DEST = "GOTHERACCOUNT0000000000000000000000000000000000000000";
const SOURCE = "GSOURCEACCOUNT000000000000000000000000000000000000000";

const DAY = 24 * 60 * 60 * 1000;

/**
 * The dry run must never write. These fakes expose only the read path and make
 * any mutation attempt fail loudly, so a test failure points at the service
 * instead of silently passing.
 */
class FakeReadOnlyRepository<T> {
  mutationAttempts = 0;

  constructor(public rows: T[]) {}

  async find(options?: { take?: number }): Promise<T[]> {
    const copy = [...this.rows];
    return options?.take ? copy.slice(0, options.take) : copy;
  }

  private forbidden(): never {
    this.mutationAttempts += 1;
    throw new Error("a dry-run reconciliation must not write");
  }

  async save(): Promise<never> {
    return this.forbidden();
  }

  async insert(): Promise<never> {
    return this.forbidden();
  }

  async update(): Promise<never> {
    return this.forbidden();
  }

  async delete(): Promise<never> {
    return this.forbidden();
  }

  async remove(): Promise<never> {
    return this.forbidden();
  }

  createQueryBuilder(): never {
    return this.forbidden();
  }
}

function invoice(partial: Partial<ReconciliationInvoice>): ReconciliationInvoice {
  return {
    invoiceId: "INV-1",
    expectedAmount: "100.0000000",
    paidAmount: "0.0000000",
    assetCode: "XLM",
    destinationAccount: DEST,
    paymentReference: null,
    status: ReconciliationInvoiceStatus.OPEN,
    ...partial,
  } as ReconciliationInvoice;
}

function transaction(
  partial: Partial<StellarTransaction>
): StellarTransaction {
  return {
    transactionId: "tx-1",
    sourceAccount: SOURCE,
    destinationAccount: DEST,
    amount: "100.0000000",
    assetCode: "XLM",
    memo: null,
    paymentReference: null,
    status: StellarTransactionStatus.UNMATCHED,
    failureReason: null,
    observedAt: new Date(),
    ...partial,
  } as StellarTransaction;
}

function buildService(
  invoices: ReconciliationInvoice[],
  transactions: StellarTransaction[],
  balanceProvider?: UserBalanceProvider
) {
  const invoiceRepo = new FakeReadOnlyRepository(invoices);
  const transactionRepo = new FakeReadOnlyRepository(transactions);
  const service = new DryRunReconciliationService(
    invoiceRepo as any,
    transactionRepo as any,
    balanceProvider
  );
  return { service, invoiceRepo, transactionRepo };
}

describe("DryRunReconciliationService", () => {
  it("reports nothing for a consistent dataset", async () => {
    const { service, invoiceRepo, transactionRepo } = buildService(
      [
        invoice({
          invoiceId: "INV-CLEAN",
          expectedAmount: "50.0000000",
          paidAmount: "50.0000000",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      [
        transaction({
          transactionId: "tx-clean",
          amount: "50.0000000",
          status: StellarTransactionStatus.MATCHED,
        }),
      ]
    );

    const report = await service.runDryRun();

    expect(report.dryRun).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.counts.total).toBe(0);
    expect(report.invariants.every((invariant) => invariant.passed)).toBe(true);
    expect(report.totals).toMatchObject({
      invoices: 1,
      transactions: 1,
      expectedAmount: "50.0000000",
      paidAmount: "50.0000000",
      matchedTransactions: 1,
      unmatchedTransactions: 0,
    });
    expect(invoiceRepo.mutationAttempts).toBe(0);
    expect(transactionRepo.mutationAttempts).toBe(0);
  });

  it("detects a paid invoice with no matching payment", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-MISSING",
          paidAmount: "75.0000000",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      []
    );

    const report = await service.runDryRun();

    const finding = report.findings.find(
      (item) => item.type === ReconciliationFindingType.MISSING_PAYMENT
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(finding?.invoiceId).toBe("INV-MISSING");
    expect(finding?.suggestedAction).toMatch(/ledger/i);
    expect(report.counts.critical).toBe(1);
    expect(
      report.invariants.find(
        (invariant) => invariant.name === "paid_invoices_have_payments"
      )
    ).toMatchObject({ passed: false });
  });

  it("detects an invoice whose payments do not cover its paid status", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-UNDER",
          expectedAmount: "100.0000000",
          paidAmount: "100.0000000",
          status: ReconciliationInvoiceStatus.PAID,
          paymentReference: "REF-UNDER",
        }),
      ],
      [
        transaction({
          transactionId: "tx-under",
          amount: "60.0000000",
          status: StellarTransactionStatus.MATCHED,
          paymentReference: "REF-UNDER",
        }),
      ]
    );

    const report = await service.runDryRun();

    const critical = report.findings.filter(
      (item) =>
        item.type === ReconciliationFindingType.AMOUNT_MISMATCH &&
        item.severity === ReconciliationSeverity.CRITICAL
    );
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({
      invoiceId: "INV-UNDER",
      expected: "100.0000000",
      actual: "60.0000000",
      delta: "40.0000000",
    });
    expect(
      report.invariants.find(
        (invariant) => invariant.name === "stored_amounts_match_transactions"
      )
    ).toMatchObject({ passed: false });
  });

  it("detects an overpayment", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-OVER",
          expectedAmount: "10.0000000",
          paidAmount: "25.0000000",
          status: ReconciliationInvoiceStatus.PAID,
          paymentReference: "REF-OVER",
        }),
      ],
      [
        transaction({
          transactionId: "tx-over",
          amount: "25.0000000",
          status: StellarTransactionStatus.MATCHED,
          paymentReference: "REF-OVER",
        }),
      ]
    );

    const report = await service.runDryRun();

    expect(report.counts.byType[ReconciliationFindingType.OVERPAYMENT]).toBe(1);
    const over = report.findings.find(
      (item) => item.type === ReconciliationFindingType.OVERPAYMENT
    );
    expect(over).toMatchObject({
      invoiceId: "INV-OVER",
      expected: "10.0000000",
      actual: "25.0000000",
      delta: "15.0000000",
      severity: ReconciliationSeverity.WARNING,
    });
    expect(
      report.invariants.find(
        (invariant) => invariant.name === "totals_within_expected"
      )
    ).toMatchObject({ passed: false });
  });

  it("detects invoice status drift", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-DRIFT",
          expectedAmount: "100.0000000",
          paidAmount: "0.0000000",
          status: ReconciliationInvoiceStatus.OPEN,
        }),
      ],
      [
        transaction({
          transactionId: "tx-drift",
          amount: "40.0000000",
          status: StellarTransactionStatus.PARTIAL,
        }),
      ]
    );

    const report = await service.runDryRun();

    const statusFindings = report.findings.filter(
      (item) => item.type === ReconciliationFindingType.STATUS_MISMATCH
    );
    expect(statusFindings).toHaveLength(1);
    expect(statusFindings[0]).toMatchObject({
      invoiceId: "INV-DRIFT",
      expected: ReconciliationInvoiceStatus.PARTIAL,
      actual: ReconciliationInvoiceStatus.OPEN,
    });

    // The stored paidAmount (0) also disagrees with the derived total (40).
    expect(
      report.counts.byType[ReconciliationFindingType.AMOUNT_MISMATCH]
    ).toBe(1);
  });

  it("detects orphan and stale unmatched transactions", async () => {
    const { service } = buildService(
      [],
      [
        transaction({
          transactionId: "tx-orphan",
          destinationAccount: OTHER_DEST,
          amount: "5.0000000",
          observedAt: new Date(Date.now() - 30 * DAY),
        }),
      ]
    );

    const report = await service.runDryRun({ staleDays: 7 });

    expect(
      report.counts.byType[ReconciliationFindingType.ORPHAN_TRANSACTION]
    ).toBe(1);
    expect(
      report.counts.byType[ReconciliationFindingType.STALE_UNMATCHED_TRANSACTION]
    ).toBe(1);
    const stale = report.findings.find(
      (item) =>
        item.type === ReconciliationFindingType.STALE_UNMATCHED_TRANSACTION
    );
    expect(stale?.ageDays).toBe(30);
    expect(report.totals.unmatchedTransactions).toBe(1);
  });

  it("does not flag a fresh unmatched transaction as stale", async () => {
    const { service } = buildService(
      [],
      [
        transaction({
          transactionId: "tx-fresh",
          destinationAccount: OTHER_DEST,
          observedAt: new Date(Date.now() - 1 * DAY),
        }),
      ]
    );

    const report = await service.runDryRun({ staleDays: 7 });

    expect(
      report.counts.byType[ReconciliationFindingType.STALE_UNMATCHED_TRANSACTION]
    ).toBe(undefined);
    expect(
      report.counts.byType[ReconciliationFindingType.ORPHAN_TRANSACTION]
    ).toBe(1);
  });

  it("detects duplicate payments", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-DUP",
          expectedAmount: "100.0000000",
          paidAmount: "100.0000000",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      [
        transaction({
          transactionId: "tx-dup-1",
          amount: "100.0000000",
          status: StellarTransactionStatus.MATCHED,
        }),
        transaction({
          transactionId: "tx-dup-2",
          amount: "100.0000000",
          status: StellarTransactionStatus.MATCHED,
        }),
      ]
    );

    const report = await service.runDryRun();

    const duplicates = report.findings.filter(
      (item) => item.type === ReconciliationFindingType.DUPLICATE_TRANSACTION
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].transactionId).toBe("tx-dup-2");
    expect(
      report.invariants.find(
        (invariant) => invariant.name === "no_duplicate_payments"
      )
    ).toMatchObject({ passed: false });
    // 200 matched against 100 expected must fail the totals invariant too.
    expect(
      report.invariants.find(
        (invariant) => invariant.name === "totals_within_expected"
      )
    ).toMatchObject({ passed: false });
  });

  it("reports failed transactions without counting them as matched", async () => {
    const { service } = buildService(
      [],
      [
        transaction({
          transactionId: "tx-failed",
          status: StellarTransactionStatus.FAILED,
          failureReason: "horizon timeout",
        }),
      ]
    );

    const report = await service.runDryRun();

    const finding = report.findings.find(
      (item) => item.type === ReconciliationFindingType.FAILED_TRANSACTION
    );
    expect(finding?.severity).toBe(ReconciliationSeverity.INFO);
    expect(finding?.message).toMatch(/horizon timeout/);
    expect(report.totals.matchedTransactions).toBe(0);
    expect(report.totals.unmatchedTransactions).toBe(0);
  });

  it("detects user-facing balance drift when a provider is configured", async () => {
    const balanceProvider: UserBalanceProvider = {
      loadSnapshots: jest.fn(async () => [
        { account: DEST, assetCode: "XLM", reportedBalance: "30.0000000" },
        { account: OTHER_DEST, assetCode: "XLM", reportedBalance: "5.0000000" },
      ]),
    };

    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-BAL",
          expectedAmount: "100.0000000",
          paidAmount: "100.0000000",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      [
        transaction({
          transactionId: "tx-bal",
          amount: "100.0000000",
          status: StellarTransactionStatus.MATCHED,
        }),
      ],
      balanceProvider
    );

    const report = await service.runDryRun();

    expect(report.userBalanceSource).toBe("provider");
    expect(balanceProvider.loadSnapshots).toHaveBeenCalledWith([DEST]);
    const drift = report.findings.find(
      (item) => item.type === ReconciliationFindingType.USER_BALANCE_DRIFT
    );
    expect(drift).toMatchObject({
      account: DEST,
      expected: "100.0000000",
      actual: "30.0000000",
      delta: "70.0000000",
    });
    expect(
      report.invariants.find(
        (invariant) => invariant.name === "user_balances_match_ledger"
      )
    ).toMatchObject({ passed: false, skipped: false });
  });

  it("skips the balance check, and says so, when no provider is configured", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-NOPROV",
          expectedAmount: "10.0000000",
          paidAmount: "10.0000000",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      [
        transaction({
          transactionId: "tx-noprov",
          amount: "10.0000000",
          status: StellarTransactionStatus.MATCHED,
        }),
      ]
    );

    const report = await service.runDryRun();

    expect(report.userBalanceSource).toBe("unavailable");
    const invariant = report.invariants.find(
      (item) => item.name === "user_balances_match_ledger"
    );
    expect(invariant).toMatchObject({ passed: true, skipped: true });
    expect(invariant?.detail).toMatch(/USER_BALANCE_PROVIDER/);

    const disabled = await service.runDryRun({ includeUserBalances: false });
    expect(disabled.userBalanceSource).toBe("disabled");
  });

  it("treats differences inside the tolerance as rounding noise", async () => {
    const { service } = buildService(
      [
        invoice({
          invoiceId: "INV-ROUND",
          expectedAmount: "10.0000000",
          paidAmount: "9.9999999",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      [
        transaction({
          transactionId: "tx-round",
          amount: "9.9999999",
          status: StellarTransactionStatus.MATCHED,
        }),
      ]
    );

    const report = await service.runDryRun({ toleranceAmount: "0.0000002" });

    expect(report.findings).toEqual([]);
    expect(report.options.toleranceAmount).toBe("0.0000002");
  });

  it("caps the inspected window and never writes", async () => {
    const invoices = Array.from({ length: 5 }, (_, index) =>
      invoice({
        invoiceId: `INV-${index}`,
        paymentReference: `ref-${index}`,
        expectedAmount: "1.0000000",
        paidAmount: "1.0000000",
        status: ReconciliationInvoiceStatus.PAID,
      })
    );
    const transactions = invoices.map((_, index) =>
      transaction({
        transactionId: `tx-${index}`,
        amount: "1.0000000",
        paymentReference: `ref-${index}`,
        status: StellarTransactionStatus.MATCHED,
      })
    );

    const { service, invoiceRepo, transactionRepo } = buildService(
      invoices,
      transactions
    );

    const report = await service.runDryRun({ limit: 2 });

    expect(report.options.limit).toBe(2);
    expect(report.totals.invoices).toBe(2);
    expect(report.totals.transactions).toBe(2);
    expect(report.findings).toEqual([]);
    expect(invoiceRepo.mutationAttempts).toBe(0);
    expect(transactionRepo.mutationAttempts).toBe(0);
    expect(invoiceRepo.rows).toHaveLength(5);
    expect(transactionRepo.rows).toHaveLength(5);
  });

  it("keeps the scheduled entry point read-only and non-throwing", async () => {
    const { service, invoiceRepo, transactionRepo } = buildService(
      [
        invoice({
          invoiceId: "INV-CRON",
          status: ReconciliationInvoiceStatus.PAID,
        }),
      ],
      []
    );

    await expect(service.scheduledDryRun()).resolves.toBeUndefined();
    expect(invoiceRepo.mutationAttempts).toBe(0);
    expect(transactionRepo.mutationAttempts).toBe(0);
  });
});
