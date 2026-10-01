import { createHash } from "crypto";
import { canonicalize } from "../../preflight/preflight.determinism";

export type OperationReceiptStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed";

export interface ReceiptOperation {
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface OperationReceipt {
  fingerprint: string;
  actor: string;
  kind: string;
  status: OperationReceiptStatus;
  requestedAt: string;
  updatedAt: string;
  externalReference?: string;
  failureReason?: string;
}

/**
 * Build the replay key for an operation. Actor and kind are included so a
 * client cannot replay another actor's request by reusing its payload.
 */
export function operationFingerprint(operation: ReceiptOperation): string {
  return createHash("sha256")
    .update(canonicalize({
      actor: operation.actor,
      kind: operation.kind,
      payload: operation.payload,
    }))
    .digest("hex");
}

export function transitionReceipt(
  receipt: OperationReceipt,
  status: OperationReceiptStatus,
  now = new Date().toISOString(),
  details: Pick<OperationReceipt, "externalReference" | "failureReason"> = {},
): OperationReceipt {
  const allowed: Record<OperationReceiptStatus, OperationReceiptStatus[]> = {
    pending: ["submitted", "failed"],
    submitted: ["confirmed", "failed"],
    confirmed: [],
    failed: ["pending"],
  };
  if (status !== receipt.status && !allowed[receipt.status].includes(status)) {
    throw new Error(`Invalid operation receipt transition: ${receipt.status} -> ${status}`);
  }
  return { ...receipt, ...details, status, updatedAt: now };
}
