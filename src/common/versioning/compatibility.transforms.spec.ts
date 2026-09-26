import {
  applyReadTransforms,
  getTransforms,
  registerTransform,
} from "./compatibility.transforms";

describe("built-in Portfolio transform (v0 → v1)", () => {
  it("renames createdDate (epoch) to createdAt (ISO) on v0 records", () => {
    const legacy = {
      id: "p1",
      createdDate: 1_700_000_000_000, // epoch ms
      schemaVersion: "0.9.0",
    };
    const result = applyReadTransforms("Portfolio", legacy as any);
    expect(result).not.toHaveProperty("createdDate");
    expect(result).toHaveProperty("createdAt");
    expect(typeof (result as any).createdAt).toBe("string");
    expect(new Date((result as any).createdAt).getTime()).toBe(1_700_000_000_000);
  });

  it("leaves v1 records unchanged (already have createdAt)", () => {
    const modern = {
      id: "p2",
      createdAt: "2024-01-01T00:00:00.000Z",
      schemaVersion: "1.0.0",
    };
    const result = applyReadTransforms("Portfolio", modern as any);
    expect(result).toHaveProperty("createdAt", "2024-01-01T00:00:00.000Z");
    expect(result).not.toHaveProperty("createdDate");
  });
});

describe("built-in User transform (v0 → v1)", () => {
  it("uppercases a legacy lowercase role", () => {
    const legacy = { id: "u1", role: "admin", schemaVersion: "0.8.0" };
    const result = applyReadTransforms("User", legacy as any);
    expect((result as any).role).toBe("ADMIN");
  });

  it("leaves an already-uppercased role unchanged", () => {
    const modern = { id: "u2", role: "OPERATOR", schemaVersion: "1.0.0" };
    const result = applyReadTransforms("User", modern as any);
    expect((result as any).role).toBe("OPERATOR");
  });
});

describe("applyReadTransforms", () => {
  it("returns the record unchanged when no transforms are registered for the entity", () => {
    const record = { id: "x", schemaVersion: "1.0.0", foo: "bar" };
    const result = applyReadTransforms("UnknownEntity", record as any);
    expect(result).toEqual(record);
  });

  it("does not mutate the original record", () => {
    const original = {
      id: "u3",
      role: "user",
      schemaVersion: "0.8.0",
    };
    applyReadTransforms("User", original as any);
    expect(original.role).toBe("user"); // original unchanged
  });
});

describe("registerTransform", () => {
  afterEach(() => {
    // Clean up custom transforms from the registry to avoid test pollution
    const existing = getTransforms("TestEntity");
    existing.length = 0; // direct mutation of the returned array is safe here
  });

  it("registers a new transform for a custom entity", () => {
    registerTransform({
      entity: "TestEntity",
      fromVersion: "^0.x",
      toVersion: "1.0.0",
      direction: "read",
      description: "test transform",
      transform: (r) => ({ ...r, upgraded: true }),
    });

    const record = { id: "t1", schemaVersion: "0.5.0" };
    const result = applyReadTransforms("TestEntity", record as any);
    expect((result as any).upgraded).toBe(true);
  });

  it("chaining multiple transforms applies them in registration order", () => {
    registerTransform({
      entity: "TestEntity",
      fromVersion: "^0.x",
      toVersion: "1.0.0",
      direction: "read",
      description: "step 1",
      transform: (r) => ({ ...r, step1: true }),
    });

    registerTransform({
      entity: "TestEntity",
      fromVersion: "^1.x",
      toVersion: "2.0.0",
      direction: "read",
      description: "step 2",
      transform: (r) => ({ ...r, step2: true }),
    });

    const record = { id: "t2" };
    const result = applyReadTransforms("TestEntity", record as any);
    expect((result as any).step1).toBe(true);
    expect((result as any).step2).toBe(true);
  });
});
