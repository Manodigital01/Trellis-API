import { detectStateDrift, StateDriftSnapshot } from "./state-drift";

const current: StateDriftSnapshot = {
  network: "testnet",
  walletAddress: "GABC",
  ledgerSequence: 42,
  cacheVersion: "cache-7",
};

describe("detectStateDrift", () => {
  it("accepts an unchanged authoritative snapshot", () => {
    expect(detectStateDrift(current, current)).toEqual({
      stale: false,
      fields: [],
      remediation: "refresh",
    });
  });

  it("requires resimulation after ledger drift", () => {
    const result = detectStateDrift(current, { ...current, ledgerSequence: 43 });
    expect(result).toEqual({
      stale: true,
      fields: ["ledgerSequence"],
      remediation: "resimulate",
    });
  });

  it("requires a refresh after cache drift", () => {
    const result = detectStateDrift(current, { ...current, cacheVersion: "cache-8" });
    expect(result).toEqual({
      stale: true,
      fields: ["cacheVersion"],
      remediation: "refresh",
    });
  });
});
