import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { buildTransactionDisclosure } from "../common/transaction-details/transaction-detail.projection";
import { sectionData } from "../common/transaction-details/transaction-detail.projection";
import {
  TransactionDetailInput,
  TransactionDetailTier,
  TransactionDisclosure,
  TransactionSectionDefinition,
  TransactionWarning,
} from "../common/transaction-details/transaction-detail.types";
import { IngestStellarTransactionDto } from "./dto/reconciliation.dto";
import { ReconciliationAudit } from "./entities/reconciliation-audit.entity";
import { ReconciliationInvoice } from "./entities/reconciliation-invoice.entity";
import {
  StellarTransaction,
  StellarTransactionStatus,
} from "./entities/stellar-transaction.entity";
import { toAuditEntry } from "./transaction-detail.presenters";

const SCALE = 7;

/**
 * Section catalogue. The `requiredTier` and `risk` values are the contract:
 * risk signals stay in the `summary` tier, protocol plumbing only appears at
 * `advanced`.
 */
export const STELLAR_TRANSACTION_SECTIONS: TransactionSectionDefinition[] = [
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
    summary:
      "Critical and warning level risks detected for this payment. Always visible.",
    risk: "critical",
    requiredTier: TransactionDetailTier.SUMMARY,
  },
  {
    id: "timeline",
    label: "Timeline",
    summary: "When the payment was observed, recorded and last reconciled.",
    risk: "info",
    requiredTier: TransactionDetailTier.STANDARD,
  },
  {
    id: "reconciliation_audit",
    label: "Reconciliation audit trail",
    summary:
      "Every decision the reconciler made for this payment, newest first.",
    risk: "info",
    requiredTier: TransactionDetailTier.STANDARD,
  },
  {
    id: "amount_precision",
    label: "Amount precision",
    summary:
      "Raw amount string, seven-decimal scale handling and the expected-versus-paid delta.",
    risk: "warning",
    requiredTier: TransactionDetailTier.ADVANCED,
  },
  {
    id: "reference_analysis",
    label: "Reference analysis",
    summary:
      "How the memo and payment reference were matched against the invoice, field by field.",
    risk: "warning",
    requiredTier: TransactionDetailTier.ADVANCED,
  },
  {
    id: "raw_payload",
    label: "Raw protocol payload",
    summary:
      "The unedited Horizon record for this payment. Contains no Trellis secrets.",
    risk: "info",
    requiredTier: TransactionDetailTier.ADVANCED,
  },
];

function section(id: TransactionSectionDefinition["id"]): TransactionSectionDefinition {
  const found = STELLAR_TRANSACTION_SECTIONS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown transaction section ${id}`);
  return found;
}

function difference(
  paid: string,
  expected: string,
): { expected: string; paid: string; delta: string } {
  const toUnits = (value: string) => {
    const [whole, fraction = ""] = String(value).split(".");
    return (
      BigInt(whole || "0") * 10n ** BigInt(SCALE) +
      BigInt(fraction.padEnd(SCALE, "0").slice(0, SCALE) || "0")
    );
  };
  const fromUnits = (units: bigint) => {
    const whole = units / 10n ** BigInt(SCALE);
    const fraction = (units % 10n ** BigInt(SCALE))
      .toString()
      .padStart(SCALE, "0");
    return `${whole}.${fraction}`;
  };
  const expectedUnits = toUnits(expected);
  const paidUnits = toUnits(paid);
  return {
    expected,
    paid,
    delta: fromUnits(expectedUnits - paidUnits),
  };
}

/**
 * Builds the tiered, warning-first projection of a Stellar payment.
 *
 * The default view stays small; `advanced` unlocks the protocol payload for
 * support and debugging. Risk information is produced independently of the
 * tier, so no client can hide a critical warning behind a collapsed section.
 *
 * Issue: #125
 */
@Injectable()
export class TransactionDetailsService {
  constructor(
    @InjectRepository(StellarTransaction)
    private readonly transactionRepo: Repository<StellarTransaction>,
    @InjectRepository(ReconciliationAudit)
    private readonly auditRepo: Repository<ReconciliationAudit>,
    @InjectRepository(ReconciliationInvoice)
    private readonly invoiceRepo: Repository<ReconciliationInvoice>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Loads a transaction with its audits and projects it at the requested tier.
   * Returns `null` when the transaction does not exist.
   */
  async describe(
    transactionId: string,
    tier: unknown,
  ): Promise<TransactionDetailResult | null> {
    const transaction = await this.transactionRepo.findOne({
      where: { transactionId },
    });
    if (!transaction) return null;

    const audits = await this.auditRepo.find({
      where: { transactionId },
      order: { createdAt: "DESC" },
    });

    const invoice = await this.invoiceRepo.findOne({
      where: { destinationAccount: transaction.destinationAccount },
      order: { createdAt: "ASC" },
    });

    return this.project(transaction, audits, invoice, tier);
  }

  /**
   * Pre-submission projection. Validates the payload, resolves what would be
   * matched and surfaces the same warnings the persisted view would carry —
   * without writing anything.
   */
  async preview(
    dto: IngestStellarTransactionDto,
    tier: unknown,
  ): Promise<TransactionPreviewResult> {
    const existing = await this.transactionRepo.findOne({
      where: { transactionId: dto.transactionId },
    });
    const invoice = await this.invoiceRepo.findOne({
      where: { destinationAccount: dto.destinationAccount },
      order: { createdAt: "ASC" },
    });

    const pseudoTransaction: StellarTransaction = existing ?? {
      transactionId: dto.transactionId,
      ledger: dto.ledger,
      sourceAccount: dto.sourceAccount,
      destinationAccount: dto.destinationAccount,
      amount: dto.amount,
      assetCode: (dto.assetCode ?? "XLM").toUpperCase(),
      memo: dto.memo,
      paymentReference: dto.memo,
      observedAt: dto.observedAt ? new Date(dto.observedAt) : new Date(),
      rawPayload: dto.rawPayload,
      status: StellarTransactionStatus.UNMATCHED,
    } as StellarTransaction;

    const audits = existing
      ? await this.auditRepo.find({
          where: { transactionId: dto.transactionId },
          order: { createdAt: "DESC" },
        })
      : [];

    const projected = this.project(pseudoTransaction, audits, invoice, tier);
    const { disclosure } = projected;
    // TypeORM resolves to `null`, never `undefined`, when nothing matches.
    const duplicate = existing !== null && existing !== undefined;

    return {
      disclosure,
      warnings: projected.warnings,
      preview: {
        dryRun: true,
        persisted: false,
        duplicate,
        wouldCreate: !duplicate,
        expandedSections: disclosure.sections
          .filter((entry) => entry.state === "expanded")
          .map((entry) => entry.id),
        transaction: toIdentity(pseudoTransaction),
        settlement: toSettlement(pseudoTransaction),
        risk: sectionData<Record<string, unknown>>(disclosure, "risk"),
      },
    };
  }

  /** Projects an in-memory transaction (used by the manual retry flow). */
  project(
    transaction: StellarTransaction,
    audits: ReconciliationAudit[],
    invoice: ReconciliationInvoice | null,
    tier: unknown,
  ): TransactionDetailResult {
    const warnings = this.buildWarnings(transaction, invoice);
    const input: TransactionDetailInput = {
      warnings,
      sections: [
        { definition: section("identity"), data: toIdentity(transaction) },
        { definition: section("settlement"), data: toSettlement(transaction) },
        { definition: section("risk"), data: this.buildRiskSummary(warnings) },
        { definition: section("timeline"), data: toTimeline(transaction) },
        {
          definition: section("reconciliation_audit"),
          data: audits.map(toAuditEntry),
        },
        {
          definition: section("amount_precision"),
          data: this.buildAmountPrecision(transaction, invoice),
        },
        {
          definition: section("reference_analysis"),
          data: this.buildReferenceAnalysis(transaction, invoice),
        },
        { definition: section("raw_payload"), data: transaction.rawPayload ?? null },
      ],
    };

    const projection = buildTransactionDisclosure(tier, input);
    return {
      disclosure: projection.disclosure,
      warnings: projection.warnings,
      transaction,
    };
  }

  /**
   * Warnings are derived from the data, never from the requested tier, so the
   * result is byte-identical for `summary`, `standard` and `advanced`.
   */
  buildWarnings(
    transaction: StellarTransaction,
    invoice: ReconciliationInvoice | null,
  ): Array<Omit<TransactionWarning, "alwaysVisible">> {
    const warnings: Array<Omit<TransactionWarning, "alwaysVisible">> = [];

    if (transaction.status === StellarTransactionStatus.FAILED) {
      warnings.push({
        code: "TRANSACTION_FAILED",
        severity: "critical",
        message:
          transaction.failureReason ??
          "The reconciler failed to process this payment. It will not settle automatically.",
        action: "Inspect the reconciliation audit trail and reconcile the invoice manually.",
      });
    }

    if (transaction.status === StellarTransactionStatus.UNMATCHED) {
      warnings.push({
        code: "UNMATCHED_PAYMENT",
        severity: "critical",
        message:
          "This payment has not been matched to any invoice, so funds are received but unreconciled.",
        action:
          "Confirm the destination account and payment reference, then retry reconciliation.",
      });
    }

    if (transaction.status === StellarTransactionStatus.PARTIAL) {
      warnings.push({
        code: "PARTIAL_PAYMENT",
        severity: "warning",
        message: "This payment only partially covers the expected invoice amount.",
        action: "Wait for the remaining payment or reconcile the shortfall manually.",
      });
    }

    if (!invoice) {
      warnings.push({
        code: "MISSING_DESTINATION",
        severity: "warning",
        message:
          "No invoice exists for this destination account, so no amount can be expected.",
        action: "Register the invoice before retrying reconciliation.",
      });
    } else {
      const delta = difference(transaction.amount, invoice.expectedAmount);
      if (delta.delta.startsWith("-")) {
        warnings.push({
          code: "OVERPAYMENT",
          severity: "warning",
          message: `Received ${delta.paid} against an expected ${delta.expected}; the difference is ${delta.delta.replace("-", "")}.`,
          action: "Decide whether to refund the surplus or credit the next invoice.",
        });
      } else if (Number(delta.delta) > 0 && transaction.status === StellarTransactionStatus.UNMATCHED) {
        warnings.push({
          code: "AMOUNT_MISMATCH",
          severity: "info",
          message: `Expected ${delta.expected} but received ${delta.paid}.`,
          action: "Check the amount on the originating invoice.",
        });
      }
    }

    if (!transaction.memo && invoice?.paymentReference) {
      warnings.push({
        code: "UNVERIFIED_REFERENCE",
        severity: "warning",
        message:
          "The payment carries no memo, so it can only be matched on destination and asset.",
        action: "Ask the payer to include the payment reference on future payments.",
      });
    }

    return warnings;
  }

  private buildRiskSummary(
    warnings: Array<Omit<TransactionWarning, "alwaysVisible">>,
  ): Record<string, unknown> {
    return {
      criticalCount: warnings.filter((w) => w.severity === "critical").length,
      warningCount: warnings.filter((w) => w.severity === "warning").length,
      highestSeverity:
        warnings.some((w) => w.severity === "critical")
          ? "critical"
          : warnings.some((w) => w.severity === "warning")
            ? "warning"
            : "none",
      codes: warnings.map((w) => w.code),
      note: "Critical signals are always present regardless of the requested detail tier.",
    };
  }

  private buildAmountPrecision(
    transaction: StellarTransaction,
    invoice: ReconciliationInvoice | null,
  ): Record<string, unknown> {
    return {
      assetCode: transaction.assetCode,
      decimalScale: SCALE,
      rawAmount: transaction.amount,
      rawExpectedAmount: invoice?.expectedAmount ?? null,
      rawPaidAmount: invoice?.paidAmount ?? null,
      invoiceStatus: invoice?.status ?? null,
      comparison: invoice
        ? difference(transaction.amount, invoice.expectedAmount)
        : null,
      note: "Stellar amounts are fixed-point with seven decimals; the raw strings are returned verbatim so no rounding is hidden.",
    };
  }

  private buildReferenceAnalysis(
    transaction: StellarTransaction,
    invoice: ReconciliationInvoice | null,
  ): Record<string, unknown> {
    const expected = invoice?.paymentReference ?? null;
    return {
      memo: transaction.memo ?? null,
      paymentReference: transaction.paymentReference ?? null,
      expectedReference: expected,
      referenceMatches: expected !== null && transaction.paymentReference === expected,
      destinationMatches:
        invoice !== null &&
        invoice.destinationAccount === transaction.destinationAccount,
      assetMatches:
        invoice !== null && invoice.assetCode === transaction.assetCode,
      matchingRule:
        "A payment matches an invoice when destination account, asset code and payment reference are all equal.",
      environment: {
        networkPassphraseConfigured: Boolean(
          this.configService.get<string>("STELLAR_NETWORK_PASSPHRASE"),
        ),
        horizonUrl: this.configService.get<string>("STELLAR_HORIZON_URL") ?? null,
      },
    };
  }
}

export interface TransactionDetailResult {
  disclosure: TransactionDisclosure;
  warnings: TransactionWarning[];
  transaction: StellarTransaction;
}

export interface TransactionPreviewResult {
  disclosure: TransactionDisclosure;
  warnings: TransactionWarning[];
  preview: Record<string, unknown>;
}

function toIdentity(transaction: StellarTransaction): Record<string, unknown> {
  return {
    transactionId: transaction.transactionId,
    ledger: transaction.ledger ?? null,
    sourceAccount: transaction.sourceAccount ?? null,
    destinationAccount: transaction.destinationAccount,
    amount: transaction.amount,
    assetCode: transaction.assetCode,
  };
}

function toSettlement(transaction: StellarTransaction): Record<string, unknown> {
  return {
    status: transaction.status,
    failureReason: transaction.failureReason ?? null,
    settled: transaction.status === StellarTransactionStatus.MATCHED,
  };
}

function toTimeline(transaction: StellarTransaction): Record<string, unknown> {
  const observed = transaction.observedAt ? new Date(transaction.observedAt) : null;
  const recorded = transaction.createdAt ? new Date(transaction.createdAt) : null;
  return {
    observedAt: observed?.toISOString() ?? null,
    recordedAt: recorded?.toISOString() ?? null,
    observationLagMs:
      observed && recorded
        ? Math.abs(recorded.getTime() - observed.getTime())
        : null,
  };
}
