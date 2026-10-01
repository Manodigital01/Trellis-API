import { ReconciliationAudit } from "./entities/reconciliation-audit.entity";

/**
 * Projects a reconciliation audit row down to the fields a client needs.
 * Keeps the audit section stable if the entity grows new columns.
 */
export function toAuditEntry(audit: ReconciliationAudit): Record<string, unknown> {
  return {
    id: audit.id,
    invoiceId: audit.invoiceId ?? null,
    transactionId: audit.transactionId ?? null,
    decision: audit.decision,
    reason: audit.reason ?? null,
    attempt: audit.attempt,
    metadata: audit.metadata ?? null,
    createdAt: audit.createdAt ? new Date(audit.createdAt).toISOString() : null,
  };
}
