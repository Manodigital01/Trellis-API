import {
  isSchemaCompatible,
  stampSchemaVersion,
  parseVersionFromPath,
  API_VERSION_CURRENT,
  RECORD_SCHEMA_VERSION_CURRENT,
} from "./schema-version";

describe("isSchemaCompatible", () => {
  it("returns true when record version satisfies the range", () => {
    expect(
      isSchemaCompatible({ schemaVersion: "1.0.0" }, "^1.0.0"),
    ).toBe(true);
  });

  it("returns false when record version does not satisfy range", () => {
    expect(
      isSchemaCompatible({ schemaVersion: "0.9.0" }, "^1.0.0"),
    ).toBe(false);
  });

  it("returns false for an invalid schemaVersion", () => {
    expect(
      isSchemaCompatible({ schemaVersion: "not-a-semver" }, "^1.0.0"),
    ).toBe(false);
  });

  it("handles upper-bound ranges", () => {
    expect(
      isSchemaCompatible({ schemaVersion: "1.5.0" }, ">=1.0.0 <2.0.0"),
    ).toBe(true);
    expect(
      isSchemaCompatible({ schemaVersion: "2.0.0" }, ">=1.0.0 <2.0.0"),
    ).toBe(false);
  });
});

describe("stampSchemaVersion", () => {
  it("adds schemaVersion to a plain object", () => {
    const record = { id: "abc", name: "Test" };
    const stamped = stampSchemaVersion(record);
    expect(stamped.schemaVersion).toBe(RECORD_SCHEMA_VERSION_CURRENT);
    expect(stamped.id).toBe("abc");
  });

  it("accepts a custom version string", () => {
    const record = { x: 1 };
    const stamped = stampSchemaVersion(record, "2.0.0");
    expect(stamped.schemaVersion).toBe("2.0.0");
  });

  it("does not mutate the original object", () => {
    const original: Record<string, unknown> = { id: 1 };
    stampSchemaVersion(original);
    expect((original as any).schemaVersion).toBeUndefined();
  });
});

describe("parseVersionFromPath", () => {
  it("parses v1 from a path", () => {
    expect(parseVersionFromPath("/api/v1/users")).toBe("1");
  });

  it("parses v2 from a path", () => {
    expect(parseVersionFromPath("/api/v2/portfolio")).toBe("2");
  });

  it("falls back to current version for an unrecognised path", () => {
    expect(parseVersionFromPath("/health")).toBe(API_VERSION_CURRENT);
    expect(parseVersionFromPath("/api/v99/foo")).toBe(API_VERSION_CURRENT);
  });
});
