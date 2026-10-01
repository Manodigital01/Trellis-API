export interface StateDriftSnapshot {
  network: string;
  walletAddress: string;
  ledgerSequence: number;
  cacheVersion: string;
}

export interface StateDriftExpectation {
  network: string;
  walletAddress: string;
  ledgerSequence: number;
  cacheVersion: string;
}

export type StateDriftField = keyof StateDriftExpectation;

export interface StateDriftResult {
  stale: boolean;
  fields: StateDriftField[];
  remediation: "refresh" | "resimulate" | "restart";
}

/**
 * Compare the state used to prepare an operation with authoritative state.
 * This is deliberately pure so callers can run it immediately before any
 * irreversible submission and tests can cover ledger, cache, and concurrency
 * drift without a database or network.
 */
export function detectStateDrift(
  expected: StateDriftExpectation,
  current: StateDriftSnapshot,
): StateDriftResult {
  const fields = (Object.keys(expected) as StateDriftField[]).filter(
    (field) => expected[field] !== current[field],
  );
  const remediation = fields.includes("network") || fields.includes("walletAddress")
    ? "restart"
    : fields.includes("ledgerSequence")
      ? "resimulate"
      : "refresh";
  return { stale: fields.length > 0, fields, remediation };
}
