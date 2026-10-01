/**
 * Types for the fault injection harness.
 *
 * Issue: #127
 */

/**
 * Failure modes the harness can reproduce. They mirror the failures that
 * actually page people: a provider that stops answering, a provider that
 * answers with something unparseable, a database that accepts half a write,
 * and a wallet that refuses to sign or run out of funds.
 */
export type FaultKind =
  /** The peer never answers within the budget. */
  | "timeout"
  /** The peer resets the connection mid-request. */
  | "connection-reset"
  /** A DNS or TLS failure before any bytes are exchanged. */
  | "network-unreachable"
  /** The peer answers, but not with the status the caller expects. */
  | "http-status"
  /** The peer answers with a body that cannot be parsed. */
  | "malformed-body"
  /** The peer answers with a valid body of the wrong shape. */
  | "malformed-payload"
  /** The write lands in part and then fails. */
  | "partial-write"
  /** The database rejects the write (unique or foreign key violation). */
  | "constraint-violation"
  /** The wallet refuses: locked, wrong chain, no signer. */
  | "wallet-unavailable"
  /** The wallet refuses: not enough gas or funds. */
  | "insufficient-funds"
  /** The node says the nonce is already used, so the tx probably landed. */
  | "nonce-too-low"
  /** The contract reverted; retrying cannot help. */
  | "execution-reverted";

export interface FaultSpec {
  kind: FaultKind;
  /**
   * How many times the fault fires before the peer behaves again. Defaults to
   * 1; use `Infinity` for a peer that never recovers.
   */
  times?: number;
  /** HTTP status for `http-status`. */
  status?: number;
  /** Replacement body for `malformed-body` or `malformed-payload`. */
  body?: unknown;
  /** Error message; used verbatim in thrown errors. */
  message?: string;
  /**
   * When to fire, counted from the first call on the named collaborator.
   * Defaults to the first call. `0` means "from the very first call".
   */
  onCall?: number;
}

export interface InjectedFault extends Required<Pick<FaultSpec, "kind" | "times">> {
  spec: FaultSpec;
  fired: number;
}

export type SideEffectKind =
  | "on-chain-submit"
  | "payment"
  | "email"
  | "webhook"
  | "row-write";

/**
 * One thing that cannot be undone by retrying: an on-chain submission, a
 * payment, an email, a webhook call, a committed row.
 */
export interface SideEffect {
  kind: SideEffectKind;
  /** Stable identity used to detect a duplicate, e.g. the payload id. */
  key: string;
  at: number;
  detail?: Record<string, unknown>;
}

export class FaultInjectionError extends Error {
  readonly kind: FaultKind;
  readonly retryable: boolean;

  constructor(
    kind: FaultKind,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message);
    this.name = "FaultInjectionError";
    this.kind = kind;
    this.retryable = options.retryable;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Default operator-facing message for each fault kind. */
export function defaultFaultMessage(
  kind: FaultKind,
  detail: { target: string; status?: number; attempt: number },
): string {
  const suffix = detail.attempt > 1 ? ` (attempt ${detail.attempt})` : "";
  switch (kind) {
    case "timeout":
      return `${detail.target} did not answer before the timeout elapsed${suffix}`;
    case "connection-reset":
      return `${detail.target} reset the connection${suffix}`;
    case "network-unreachable":
      return `${detail.target} could not be reached; check DNS, egress and TLS${suffix}`;
    case "http-status":
      return `${detail.target} answered HTTP ${detail.status ?? "an error status"}${suffix}`;
    case "malformed-body":
      return `${detail.target} returned a body that is not valid JSON${suffix}`;
    case "malformed-payload":
      return `${detail.target} returned a well-formed body with an unexpected shape${suffix}`;
    case "partial-write":
      return `${detail.target} accepted part of the write and then failed${suffix}`;
    case "constraint-violation":
      return `${detail.target} rejected the write: a uniqueness or foreign key constraint was violated${suffix}`;
    case "wallet-unavailable":
      return `The submitter wallet is unavailable: the signer could not be loaded${suffix}`;
    case "insufficient-funds":
      return `The submitter wallet has insufficient funds for gas${suffix}`;
    case "nonce-too-low":
      return `The node rejected the nonce as already used; the transaction may already be on chain${suffix}`;
    case "execution-reverted":
      return `The contract reverted; retrying the same call cannot succeed${suffix}`;
  }
}

export function isRetryableFaultKind(kind: FaultKind): boolean {
  return (
    kind === "timeout" ||
    kind === "connection-reset" ||
    kind === "network-unreachable" ||
    kind === "http-status" ||
    kind === "partial-write"
  );
}
