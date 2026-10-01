import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Repository } from "typeorm";
import {
  DEFAULT_DRY_RUN_LIMIT,
  DEFAULT_STALE_DAYS,
  DEFAULT_TOLERANCE_AMOUNT,
  DryRunReconciliationDto,
  MAX_DRY_RUN_LIMIT,
} from "./dto/dry-run-reconciliation.dto";
import {
  ReconciliationInvoice,
  ReconciliationInvoiceStatus,
} from "./entities/reconciliation-invoice.entity";
import {
  StellarTransaction,
  StellarTransactionStatus,
} from "./entities/stellar-transaction.entity";
import { DistributedLock } from "../infrastructure/distributed-lock/distributed-lock.decorator";

/**
 * Injection token for the user-facing balance source (the API's own balance
 * view, or a ledger snapshot service). Optional: without a provider the job
 * still reconciles invoices against transactions and says so explicitly.
 */
export const USER_BALANCE_PROVIDER = "USER_BALANCE_PROVIDER";

export interface UserBalanceSnapshot {
  account: string;
  assetCode: string;
  reportedBalance: string;
}

export interface UserBalanceProvider {
  loadSnapshots(accounts: string[]): Promise<UserBalanceSnapshot[]>;
}

export enum ReconciliationFindingType {
  MISSING_PAYMENT = "missing_payment",
  AMOUNT_MISMATCH = "amount_mismatch",
  OVERPAYMENT = "overpayment",
  STATUS_MISMATCH = "status_mismatch",
  ORPHAN_TRANSACTION = "orphan_transaction",
  DUPLICATE_TRANSACTION = "duplicate_transaction",
  STALE_UNMATCHED_TRANSACTION = "stale_unmatched_transaction",
  FAILED_TRANSACTION = "failed_transaction",
  USER_BALANCE_DRIFT = "user_balance_drift",
}

export enum ReconciliationSeverity {
  CRITICAL = "critical",
  WARNING = "warning",
  INFO = "info",
}

export interface ReconciliationFinding {
  type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  message: string;
  suggestedAction: string;
  invoiceId?: string | null;
  transactionId?: string | null;
  account?: string | null;
  assetCode?: string | null;
  expected?: string | null;
  actual?: string | null;
  delta?: string | null;
  ageDays?: number | null;
}

export interface ReconciliationInvariant {
  name: string;
  passed: boolean;
  detail: string;
  /** True when the invariant could not be evaluated (e.g. no balance source). */
  skipped?: boolean;
}

export interface DryRunTotals {
  invoices: number;
  transactions: number;
  expectedAmount: string;
  paidAmount: string;
  matchedTransactions: number;
  unmatchedTransactions: number;
}

export interface DryRunCounts {
  total: number;
  critical: number;
  warning: number;
  info: number;
  byType: Record<string, number>;
}

export interface ReconciliationDryRunReport {
  dryRun: true;
  readOnly: true;
  generatedAt: string;
  durationMs: number;
  options: {
    staleDays: number;
    limit: number;
    toleranceAmount: string;
    includeUserBalances: boolean;
  };
  totals: DryRunTotals;
  counts: DryRunCounts;
  invariants: ReconciliationInvariant[];
  findings: ReconciliationFinding[];
  userBalanceSource: "provider" | "unavailable" | "disabled";
}

const SCALE = 7n;
const SCALE_FACTOR = 10n ** SCALE;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const SEVERITY_ORDER: Record<ReconciliationSeverity, number> = {
  [ReconciliationSeverity.CRITICAL]: 0,
  [ReconciliationSeverity.WARNING]: 1,
  [ReconciliationSeverity.INFO]: 2,
};

const REPAIR_GUIDANCE: Record<ReconciliationFindingType, string> = {
  [ReconciliationFindingType.MISSING_PAYMENT]:
    "Do not mark the invoice paid again. Locate the settlement in the ledger (or the payment provider) and, once found, reconcile it with the existing invoice so the transaction is linked instead of duplicated.",
  [ReconciliationFindingType.AMOUNT_MISMATCH]:
    "Compare the invoice's stored paid amount with the sum of its matched transactions and rebuild the derived value from transactions before changing any status by hand.",
  [ReconciliationFindingType.OVERPAYMENT]:
    "Confirm the surplus with the customer or provider before adjusting anything; the extra amount usually belongs to a different invoice or needs a refund.",
  [ReconciliationFindingType.STATUS_MISMATCH]:
    "Recompute the invoice status from its matched transactions; if the manual value was correct, record the override with a reason instead of editing the row silently.",
  [ReconciliationFindingType.ORPHAN_TRANSACTION]:
    "Check whether the payment belongs to an invoice that was never registered (or was registered under another destination/asset) before re-ingesting or quarantining it.",
  [ReconciliationFindingType.DUPLICATE_TRANSACTION]:
    "Verify the ledger only once for this payment; if the same transfer arrived twice, keep the first match and quarantine the duplicate instead of double-crediting the invoice.",
  [ReconciliationFindingType.STALE_UNMATCHED_TRANSACTION]:
    "Investigate why the payment never matched: missing invoice, wrong memo/reference, or unsupported asset. Resolve it or mark it as intentionally unmatched with a note.",
  [ReconciliationFindingType.FAILED_TRANSACTION]:
    "A previous reconciliation attempt failed for this transaction. Check the stored failureReason, fix the underlying cause, and retry it through the normal reconciliation path.",
  [ReconciliationFindingType.USER_BALANCE_DRIFT]:
    "Recompute the user-facing balance from settled transactions; drift usually means a settlement applied to the ledger but not to the stored balance (or the opposite).",
};

function toUnits(value: string): bigint {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  return (
    BigInt(whole) * SCALE_FACTOR +
    BigInt(fraction.padEnd(Number(SCALE), "0").slice(0, Number(SCALE)))
  );
}

function fromUnits(units: bigint): string {
  const whole = units / SCALE_FACTOR;
  const fraction = (units % SCALE_FACTOR)
    .toString()
    .padStart(Number(SCALE), "0");
  return `${whole}.${fraction}`;
}

function absUnits(units: bigint): bigint {
  return units < 0n ? -units : units;
}

function isPositiveAmount(value: string): boolean {
  try {
    return toUnits(value) > 0n;
  } catch {
    return false;
  }
}

/**
 * Read-only reconciliation of invoices, ingested transactions, and (when a
 * provider is configured) user-facing balances.
 *
 * The job never writes: it loads a bounded window, derives what the stored data
 * *should* look like, and reports the drift it finds with repair guidance. That
 * makes it safe to run in local development, in CI-like environments, and on
 * production schedules - an operator decides what to repair.
 */
@Injectable()
export class DryRunReconciliationService {
  private readonly logger = new Logger(DryRunReconciliationService.name);

  constructor(
    @InjectRepository(ReconciliationInvoice)
    private readonly invoiceRepo: Repository<ReconciliationInvoice>,
    @InjectRepository(StellarTransaction)
    private readonly transactionRepo: Repository<StellarTransaction>,
    @Optional()
    @Inject(USER_BALANCE_PROVIDER)
    private readonly balanceProvider?: UserBalanceProvider
  ) {}

  /** Produces a dry-run report. Contains no write paths. */
  async runDryRun(
    dto: DryRunReconciliationDto = {}
  ): Promise<ReconciliationDryRunReport> {
    const startedAt = Date.now();
    const now = new Date();
    const staleDays = dto.staleDays ?? DEFAULT_STALE_DAYS;
    const limit = Math.min(dto.limit ?? DEFAULT_DRY_RUN_LIMIT, MAX_DRY_RUN_LIMIT);
    const toleranceUnits = toUnits(dto.toleranceAmount ?? DEFAULT_TOLERANCE_AMOUNT);
    const includeUserBalances = dto.includeUserBalances !== false;

    const invoices = await this.invoiceRepo.find({
      order: { createdAt: "ASC" },
      take: limit,
    });
    const transactions = await this.transactionRepo.find({
      order: { observedAt: "ASC" },
      take: limit,
    });

    const findings: ReconciliationFinding[] = [];
    const derivedByAccount = new Map<string, bigint>();

    let expectedTotal = 0n;
    let paidTotal = 0n;
    let matchedTransactions = 0;
    let unmatchedTransactions = 0;

    for (const invoice of invoices) {
      const matched = transactions.filter((transaction) =>
        this.matchesInvoice(transaction, invoice)
      );
      const matchedUnits = matched.reduce(
        (total, transaction) => total + this.safeUnits(transaction.amount),
        0n
      );
      const expectedUnits = this.safeUnits(invoice.expectedAmount);
      const storedPaidUnits = this.safeUnits(invoice.paidAmount);
      const key = `${invoice.destinationAccount}|${invoice.assetCode}`;

      derivedByAccount.set(key, (derivedByAccount.get(key) ?? 0n) + matchedUnits);

      expectedTotal += expectedUnits;
      paidTotal += matchedUnits;

      // A zero-amount invoice carries no payment expectation, so its stored
      // status is not compared against a derived one.
      const derivedStatus =
        expectedUnits > 0n
          ? this.deriveStatus(matchedUnits, expectedUnits, toleranceUnits)
          : invoice.status;

      if (
        invoice.status === ReconciliationInvoiceStatus.PAID &&
        matched.length === 0
      ) {
        findings.push({
          type: ReconciliationFindingType.MISSING_PAYMENT,
          severity: ReconciliationSeverity.CRITICAL,
          message: `Invoice ${invoice.invoiceId} is marked paid but no transaction matches its destination, asset, and reference.`,
          suggestedAction: REPAIR_GUIDANCE[ReconciliationFindingType.MISSING_PAYMENT],
          invoiceId: invoice.invoiceId,
          account: invoice.destinationAccount,
          assetCode: invoice.assetCode,
          expected: invoice.expectedAmount,
          actual: invoice.paidAmount,
        });
      } else if (
        invoice.status === ReconciliationInvoiceStatus.PAID &&
        matchedUnits + toleranceUnits < expectedUnits
      ) {
        findings.push({
          type: ReconciliationFindingType.AMOUNT_MISMATCH,
          severity: ReconciliationSeverity.CRITICAL,
          message: `Invoice ${invoice.invoiceId} is marked paid but its matched transactions only cover ${fromUnits(matchedUnits)} of ${invoice.expectedAmount}.`,
          suggestedAction: REPAIR_GUIDANCE[ReconciliationFindingType.AMOUNT_MISMATCH],
          invoiceId: invoice.invoiceId,
          account: invoice.destinationAccount,
          assetCode: invoice.assetCode,
          expected: invoice.expectedAmount,
          actual: fromUnits(matchedUnits),
          delta: fromUnits(expectedUnits - matchedUnits),
        });
      } else if (matchedUnits > expectedUnits + toleranceUnits) {
        findings.push({
          type: ReconciliationFindingType.OVERPAYMENT,
          severity: ReconciliationSeverity.WARNING,
          message: `Invoice ${invoice.invoiceId} received ${fromUnits(matchedUnits)} against an expected ${invoice.expectedAmount}.`,
          suggestedAction: REPAIR_GUIDANCE[ReconciliationFindingType.OVERPAYMENT],
          invoiceId: invoice.invoiceId,
          account: invoice.destinationAccount,
          assetCode: invoice.assetCode,
          expected: invoice.expectedAmount,
          actual: fromUnits(matchedUnits),
          delta: fromUnits(matchedUnits - expectedUnits),
        });
      }

      if (absUnits(storedPaidUnits - matchedUnits) > toleranceUnits) {
        findings.push({
          type: ReconciliationFindingType.AMOUNT_MISMATCH,
          severity: ReconciliationSeverity.WARNING,
          message: `Invoice ${invoice.invoiceId} stores paidAmount ${invoice.paidAmount} but its matched transactions add up to ${fromUnits(matchedUnits)}.`,
          suggestedAction: REPAIR_GUIDANCE[ReconciliationFindingType.AMOUNT_MISMATCH],
          invoiceId: invoice.invoiceId,
          expected: fromUnits(matchedUnits),
          actual: invoice.paidAmount,
          delta: fromUnits(absUnits(storedPaidUnits - matchedUnits)),
        });
      }

      if (
        invoice.status !== ReconciliationInvoiceStatus.FAILED &&
        derivedStatus !== invoice.status
      ) {
        findings.push({
          type: ReconciliationFindingType.STATUS_MISMATCH,
          severity: ReconciliationSeverity.WARNING,
          message: `Invoice ${invoice.invoiceId} has status "${invoice.status}" but its transactions imply "${derivedStatus}".`,
          suggestedAction: REPAIR_GUIDANCE[ReconciliationFindingType.STATUS_MISMATCH],
          invoiceId: invoice.invoiceId,
          account: invoice.destinationAccount,
          assetCode: invoice.assetCode,
          expected: derivedStatus,
          actual: invoice.status,
        });
      }
    }

    for (const transaction of transactions) {
      const invoice = invoices.find((candidate) =>
        this.matchesInvoice(transaction, candidate)
      );

      if (transaction.status === StellarTransactionStatus.UNMATCHED) {
        unmatchedTransactions += 1;
        if (!invoice) {
          findings.push({
            type: ReconciliationFindingType.ORPHAN_TRANSACTION,
            severity: ReconciliationSeverity.WARNING,
            message: `Transaction ${transaction.transactionId} (${transaction.amount} ${transaction.assetCode}) matches no invoice destination.`,
            suggestedAction:
              REPAIR_GUIDANCE[ReconciliationFindingType.ORPHAN_TRANSACTION],
            transactionId: transaction.transactionId,
            account: transaction.destinationAccount,
            assetCode: transaction.assetCode,
            actual: transaction.amount,
          });
        }

        const ageDays = this.ageInDays(transaction.observedAt, now);
        if (ageDays !== null && ageDays >= staleDays) {
          findings.push({
            type: ReconciliationFindingType.STALE_UNMATCHED_TRANSACTION,
            severity: ReconciliationSeverity.WARNING,
            message: `Transaction ${transaction.transactionId} has been unmatched for ${ageDays} day(s) (threshold ${staleDays}).`,
            suggestedAction:
              REPAIR_GUIDANCE[
                ReconciliationFindingType.STALE_UNMATCHED_TRANSACTION
              ],
            transactionId: transaction.transactionId,
            account: transaction.destinationAccount,
            assetCode: transaction.assetCode,
            ageDays,
          });
        }
      } else if (transaction.status === StellarTransactionStatus.FAILED) {
        // Neither matched nor unmatched: reported on its own so the totals
        // stay readable and the retry path stays visible.
        findings.push({
          type: ReconciliationFindingType.FAILED_TRANSACTION,
          severity: ReconciliationSeverity.INFO,
          message: `Transaction ${transaction.transactionId} failed a previous reconciliation attempt: ${
            transaction.failureReason ?? "no reason recorded"
          }.`,
          suggestedAction:
            REPAIR_GUIDANCE[ReconciliationFindingType.FAILED_TRANSACTION],
          transactionId: transaction.transactionId,
          account: transaction.destinationAccount,
          assetCode: transaction.assetCode,
          actual: transaction.amount,
        });
      } else {
        matchedTransactions += 1;
        if (!invoice) {
          findings.push({
            type: ReconciliationFindingType.STATUS_MISMATCH,
            severity: ReconciliationSeverity.WARNING,
            message: `Transaction ${transaction.transactionId} is stored as "${transaction.status}" but no invoice matches it.`,
            suggestedAction:
              REPAIR_GUIDANCE[ReconciliationFindingType.STATUS_MISMATCH],
            transactionId: transaction.transactionId,
            account: transaction.destinationAccount,
            assetCode: transaction.assetCode,
            actual: transaction.status,
          });
        }
      }
    }

    findings.push(...this.findDuplicateTransactions(transactions));

    let userBalanceSource: ReconciliationDryRunReport["userBalanceSource"] =
      "unavailable";
    if (!includeUserBalances) {
      userBalanceSource = "disabled";
    } else if (this.balanceProvider) {
      userBalanceSource = "provider";
      const accounts = [...derivedByAccount.keys()];
      const snapshots = await this.loadBalanceSnapshots(accounts);
      findings.push(
        ...this.findBalanceDrift(derivedByAccount, snapshots, toleranceUnits)
      );
    }

    const sortedFindings = this.sortFindings(findings);
    const counts = this.countFindings(sortedFindings);

    return {
      dryRun: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      options: {
        staleDays,
        limit,
        toleranceAmount: fromUnits(toleranceUnits),
        includeUserBalances,
      },
      totals: {
        invoices: invoices.length,
        transactions: transactions.length,
        expectedAmount: fromUnits(expectedTotal),
        paidAmount: fromUnits(paidTotal),
        matchedTransactions,
        unmatchedTransactions,
      },
      counts,
      invariants: this.buildInvariants(
        counts,
        userBalanceSource,
        expectedTotal,
        paidTotal
      ),
      findings: sortedFindings,
      userBalanceSource,
    };
  }

  /**
   * Daily safety net. Read-only, so it cannot damage production data; operators
   * read the logged summary and act through the regular reconciliation paths.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  @DistributedLock("reconciliation:daily-dry-run", 30 * 60_000)
  async scheduledDryRun(): Promise<void> {
    try {
      const report = await this.runDryRun();
      this.logger.log(
        `reconciliation dry-run: ${report.counts.total} finding(s) ` +
          `(${report.counts.critical} critical) over ${report.totals.invoices} invoice(s) ` +
          `and ${report.totals.transactions} transaction(s) in ${report.durationMs}ms`
      );
    } catch (error) {
      this.logger.error(
        `reconciliation dry-run failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private matchesInvoice(
    transaction: StellarTransaction,
    invoice: ReconciliationInvoice
  ): boolean {
    if (transaction.destinationAccount !== invoice.destinationAccount) {
      return false;
    }
    if (transaction.assetCode !== invoice.assetCode) return false;
    if (
      invoice.paymentReference &&
      invoice.paymentReference !== transaction.paymentReference
    ) {
      return false;
    }
    return true;
  }

  private deriveStatus(
    matchedUnits: bigint,
    expectedUnits: bigint,
    tolerance: bigint
  ): ReconciliationInvoiceStatus {
    if (matchedUnits + tolerance >= expectedUnits) {
      return ReconciliationInvoiceStatus.PAID;
    }
    if (matchedUnits > tolerance) return ReconciliationInvoiceStatus.PARTIAL;
    return ReconciliationInvoiceStatus.OPEN;
  }

  private findDuplicateTransactions(
    transactions: StellarTransaction[]
  ): ReconciliationFinding[] {
    const groups = new Map<string, StellarTransaction[]>();

    for (const transaction of transactions) {
      const key = [
        transaction.destinationAccount,
        transaction.assetCode,
        transaction.amount,
        transaction.sourceAccount ?? "-",
        transaction.paymentReference ?? transaction.memo ?? "-",
      ].join("|");
      const bucket = groups.get(key) ?? [];
      bucket.push(transaction);
      groups.set(key, bucket);
    }

    const findings: ReconciliationFinding[] = [];
    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      for (const transaction of bucket.slice(1)) {
        findings.push({
          type: ReconciliationFindingType.DUPLICATE_TRANSACTION,
          severity: ReconciliationSeverity.WARNING,
          message: `Transaction ${transaction.transactionId} looks like a duplicate of ${bucket[0].transactionId}: same source, destination, amount, and reference (${transaction.amount} ${transaction.assetCode}).`,
          suggestedAction:
            REPAIR_GUIDANCE[ReconciliationFindingType.DUPLICATE_TRANSACTION],
          transactionId: transaction.transactionId,
          account: transaction.destinationAccount,
          assetCode: transaction.assetCode,
          actual: transaction.amount,
        });
      }
    }
    return findings;
  }

  private async loadBalanceSnapshots(
    accounts: string[]
  ): Promise<UserBalanceSnapshot[]> {
    if (accounts.length === 0 || !this.balanceProvider) return [];
    try {
      return await this.balanceProvider.loadSnapshots(accounts);
    } catch (error) {
      this.logger.warn(
        `user balance snapshot unavailable, skipping drift check: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  }

  private findBalanceDrift(
    derivedByAccount: Map<string, bigint>,
    snapshots: UserBalanceSnapshot[],
    tolerance: bigint
  ): ReconciliationFinding[] {
    const reported = new Map<string, bigint>();
    for (const snapshot of snapshots) {
      if (!isPositiveAmount(snapshot.reportedBalance)) {
        reported.set(`${snapshot.account}|${snapshot.assetCode}`, 0n);
        continue;
      }
      reported.set(
        `${snapshot.account}|${snapshot.assetCode}`,
        this.safeUnits(snapshot.reportedBalance)
      );
    }

    const findings: ReconciliationFinding[] = [];
    for (const [key, derivedUnits] of derivedByAccount.entries()) {
      const hasReported = reported.has(key);
      if (!hasReported && derivedUnits <= tolerance) continue;

      const reportedUnits = reported.get(key) ?? 0n;
      const delta = derivedUnits - reportedUnits;
      if (absUnits(delta) <= tolerance) continue;

      const [account, assetCode] = key.split("|");
      findings.push({
        type: ReconciliationFindingType.USER_BALANCE_DRIFT,
        severity: ReconciliationSeverity.WARNING,
        message: hasReported
          ? `Account ${account} (${assetCode}) was credited ${fromUnits(derivedUnits)} by matched transactions but its user-facing balance reports ${fromUnits(reportedUnits)}.`
          : `Account ${account} (${assetCode}) was credited ${fromUnits(derivedUnits)} by matched transactions but has no user-facing balance record.`,
        suggestedAction:
          REPAIR_GUIDANCE[ReconciliationFindingType.USER_BALANCE_DRIFT],
        account,
        assetCode,
        expected: fromUnits(derivedUnits),
        actual: hasReported ? fromUnits(reportedUnits) : null,
        delta: fromUnits(absUnits(delta)),
      });
    }
    return findings;
  }

  private buildInvariants(
    counts: DryRunCounts,
    userBalanceSource: ReconciliationDryRunReport["userBalanceSource"],
    expectedTotal: bigint,
    paidTotal: bigint
  ): ReconciliationInvariant[] {
    const has = (type: ReconciliationFindingType) =>
      (counts.byType[type] ?? 0) === 0;

    return [
      {
        name: "paid_invoices_have_payments",
        passed: has(ReconciliationFindingType.MISSING_PAYMENT),
        detail: has(ReconciliationFindingType.MISSING_PAYMENT)
          ? "Every paid invoice has at least one matching transaction."
          : `${counts.byType[ReconciliationFindingType.MISSING_PAYMENT]} paid invoice(s) have no matching transaction.`,
      },
      {
        name: "stored_amounts_match_transactions",
        passed: has(ReconciliationFindingType.AMOUNT_MISMATCH),
        detail: has(ReconciliationFindingType.AMOUNT_MISMATCH)
          ? "Every invoice's paid amount equals the sum of its matched transactions."
          : `${counts.byType[ReconciliationFindingType.AMOUNT_MISMATCH]} invoice(s) disagree with their transactions.`,
      },
      {
        name: "invoice_status_matches_payments",
        passed: has(ReconciliationFindingType.STATUS_MISMATCH),
        detail: has(ReconciliationFindingType.STATUS_MISMATCH)
          ? "Invoice statuses agree with their matched transactions."
          : `${counts.byType[ReconciliationFindingType.STATUS_MISMATCH]} invoice/transaction record(s) disagree with their payments.`,
      },
      {
        name: "no_duplicate_payments",
        passed: has(ReconciliationFindingType.DUPLICATE_TRANSACTION),
        detail: has(ReconciliationFindingType.DUPLICATE_TRANSACTION)
          ? "No two transactions look like the same payment."
          : `${counts.byType[ReconciliationFindingType.DUPLICATE_TRANSACTION]} possible duplicate transaction(s).`,
      },
      {
        name: "totals_within_expected",
        passed: paidTotal <= expectedTotal,
        detail:
          paidTotal <= expectedTotal
            ? `Matched ${fromUnits(paidTotal)} against ${fromUnits(expectedTotal)} expected.`
            : `Matched ${fromUnits(paidTotal)} exceeds ${fromUnits(expectedTotal)} expected (overpayment or duplicated credit).`,
      },
      {
        name: "user_balances_match_ledger",
        passed: has(ReconciliationFindingType.USER_BALANCE_DRIFT),
        skipped: userBalanceSource !== "provider",
        detail:
          userBalanceSource === "provider"
            ? has(ReconciliationFindingType.USER_BALANCE_DRIFT)
              ? "User-facing balances match derived transaction totals."
              : `${counts.byType[ReconciliationFindingType.USER_BALANCE_DRIFT]} account(s) drifted from derived totals.`
            : userBalanceSource === "disabled"
              ? "Skipped: user balance comparison was disabled for this run."
              : `Skipped: no USER_BALANCE_PROVIDER is configured, so derived totals were not compared with user-facing balances.`,
      },
    ];
  }

  private sortFindings(
    findings: ReconciliationFinding[]
  ): ReconciliationFinding[] {
    return [...findings].sort((left, right) => {
      const bySeverity =
        SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (bySeverity !== 0) return bySeverity;
      if (left.type !== right.type) return left.type < right.type ? -1 : 1;
      return String(left.transactionId ?? left.invoiceId ?? "").localeCompare(
        String(right.transactionId ?? right.invoiceId ?? "")
      );
    });
  }

  private countFindings(findings: ReconciliationFinding[]): DryRunCounts {
    const byType: Record<string, number> = {};
    let critical = 0;
    let warning = 0;
    let info = 0;

    for (const finding of findings) {
      byType[finding.type] = (byType[finding.type] ?? 0) + 1;
      if (finding.severity === ReconciliationSeverity.CRITICAL) critical += 1;
      else if (finding.severity === ReconciliationSeverity.WARNING) warning += 1;
      else info += 1;
    }

    return { total: findings.length, critical, warning, info, byType };
  }

  private ageInDays(observedAt: Date | null, now: Date): number | null {
    if (!observedAt) return null;
    const observed = new Date(observedAt).getTime();
    if (Number.isNaN(observed)) return null;
    return Math.floor((now.getTime() - observed) / MS_PER_DAY);
  }

  private safeUnits(value: string): bigint {
    try {
      return toUnits(value ?? "0");
    } catch {
      return 0n;
    }
  }
}
