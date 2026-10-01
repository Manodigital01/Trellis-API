import {
  CIRCULAR,
  REDACTED,
  sanitizeAuditPayload,
} from "./audit-payload.sanitizer";

describe("sanitizeAuditPayload", () => {
  it("redacts secret-looking keys at any depth and reports their paths", () => {
    const result = sanitizeAuditPayload({
      actorId: "user-1",
      metadata: {
        withdrawalApproved: true,
        webhookSecret: "whsec_live_123",
        nested: { signingKey: "SABCDEF", note: "keep me" },
      },
    });

    expect(result.value).toEqual({
      actorId: "user-1",
      metadata: {
        withdrawalApproved: true,
        webhookSecret: REDACTED,
        nested: { signingKey: REDACTED, note: "keep me" },
      },
    });
    expect(result.redactedPaths).toEqual([
      "metadata.webhookSecret",
      "metadata.nested.signingKey",
    ]);
    expect(JSON.stringify(result.value)).not.toContain("whsec_live_123");
    expect(JSON.stringify(result.value)).not.toContain("SABCDEF");
  });

  it("keeps ordinary context intact", () => {
    const result = sanitizeAuditPayload({
      status: "active",
      roles: ["viewer", "operator"],
      score: 42,
      enabled: false,
      createdAt: new Date("2026-09-26T12:00:00.000Z"),
    });

    expect(result.value).toEqual({
      status: "active",
      roles: ["viewer", "operator"],
      score: 42,
      enabled: false,
      createdAt: "2026-09-26T12:00:00.000Z",
    });
    expect(result.redactedPaths).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("truncates oversized strings instead of storing whole documents", () => {
    const result = sanitizeAuditPayload(
      { reason: "x".repeat(50) },
      { maxStringLength: 10 }
    );

    expect((result.value as { reason: string }).reason).toBe(
      "xxxxxxxxxx...[truncated]"
    );
    expect(result.truncated).toBe(true);
  });

  it("caps depth and array length", () => {
    const deep = { l1: { l2: { l3: { l4: "too deep" } } } };
    const deepResult = sanitizeAuditPayload(deep, { maxDepth: 2 });
    expect(deepResult.truncated).toBe(true);
    expect(deepResult.value).toEqual({ l1: { l2: REDACTED } });

    const longArray = { ids: [1, 2, 3, 4, 5] };
    const arrayResult = sanitizeAuditPayload(longArray, { maxArrayLength: 2 });
    expect(arrayResult.value).toEqual({ ids: [1, 2] });
    expect(arrayResult.truncated).toBe(true);
  });

  it("breaks reference cycles", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    const result = sanitizeAuditPayload(cyclic);

    expect(result.value).toEqual({ name: "loop", self: CIRCULAR });
  });

  it("drops non-serializable values and returns null for non-object payloads", () => {
    const result = sanitizeAuditPayload({
      callback: () => undefined,
      symbol: Symbol("nope"),
      keep: "yes",
    });

    expect(result.value).toEqual({ keep: "yes" });
    expect(sanitizeAuditPayload("just a string").value).toBeNull();
    expect(sanitizeAuditPayload(null).value).toBeNull();
  });

  it("matches secret keys case-insensitively and on separators", () => {
    const result = sanitizeAuditPayload({
      Authorization: "Bearer abc",
      "api-key": "k",
      api_key: "k",
      refreshToken: "rt",
      CVV: "123",
    });

    expect(Object.values(result.value as object)).toEqual([
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
    ]);
    expect(result.redactedPaths.sort()).toEqual([
      "Authorization",
      "CVV",
      "api-key",
      "api_key",
      "refreshToken",
    ]);
  });
});
