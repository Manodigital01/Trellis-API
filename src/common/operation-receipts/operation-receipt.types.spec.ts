import {
  operationFingerprint,
  transitionReceipt,
  OperationReceipt,
} from "./operation-receipt.types";

describe("operation receipts", () => {
  const receipt: OperationReceipt = {
    fingerprint: "abc",
    actor: "user-1",
    kind: "payment",
    status: "pending",
    requestedAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };

  it("fingerprints equivalent payloads canonically", () => {
    expect(
      operationFingerprint({ actor: "user-1", kind: "payment", payload: { b: 2, a: 1 } }),
    ).toBe(
      operationFingerprint({ actor: "user-1", kind: "payment", payload: { a: 1, b: 2 } }),
    );
  });

  it("allows the forward lifecycle and rejects skipping states", () => {
    const submitted = transitionReceipt(receipt, "submitted");
    expect(submitted.status).toBe("submitted");
    expect(() => transitionReceipt(receipt, "confirmed")).toThrow(
      "Invalid operation receipt transition",
    );
  });
});
