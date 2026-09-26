import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { QuotaBudgetService, DEFAULT_QUOTA_POLICIES } from "./quota-budget.service";
import { QUOTA_BUDGET_REDIS } from "./quota-budget.constants";

// Helper: build a service without Redis (memory-only mode)
async function buildService(): Promise<QuotaBudgetService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      QuotaBudgetService,
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: QUOTA_BUDGET_REDIS, useValue: null },
    ],
  }).compile();

  return module.get(QuotaBudgetService);
}

describe("QuotaBudgetService (memory mode)", () => {
  let service: QuotaBudgetService;

  beforeEach(async () => {
    service = await buildService();
  });

  it("allows consumption within limits", async () => {
    const result = await service.consume("compute:job", "user:1", 1);
    expect(result.allowed).toBe(true);
    expect(result.total).toBe(1);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("blocks when limit is exceeded", async () => {
    // Override the default policy with a very low limit
    service.registerPolicy({
      resource: "compute:job",
      limit: 2,
      windowMs: 60_000,
      description: "test low limit",
    });

    await service.consume("compute:job", "user:over", 1);
    await service.consume("compute:job", "user:over", 1);
    const result = await service.consume("compute:job", "user:over", 1);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.message).toMatch(/Quota exceeded/i);
    expect(result.message).toMatch(/administrator/i);
  });

  it("does not block different actors from each other", async () => {
    service.registerPolicy({
      resource: "compute:job",
      limit: 1,
      windowMs: 60_000,
      description: "one request only",
    });

    await service.consume("compute:job", "user:A", 1);
    const result = await service.consume("compute:job", "user:B", 1);
    expect(result.allowed).toBe(true);
  });

  it("resets quota after window expiry", async () => {
    service.registerPolicy({
      resource: "search:query",
      limit: 1,
      windowMs: 1, // 1ms window — expires immediately
      description: "instant expiry",
    });

    await service.consume("search:query", "user:reset", 1);
    await new Promise((r) => setTimeout(r, 5)); // let window expire
    const result = await service.consume("search:query", "user:reset", 1);
    expect(result.allowed).toBe(true);
    expect(result.total).toBe(1); // fresh window
  });

  it("allows consumption when no policy is registered for resource", async () => {
    const result = await service.consume("unknown:resource" as any, "user:1", 5);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(Infinity);
  });

  it("peek does not increment usage", async () => {
    service.registerPolicy({
      resource: "oracle:submit",
      limit: 5,
      windowMs: 60_000,
      description: "oracle peek test",
    });

    const before = await service.peek("oracle:submit", "user:peeker");
    expect(before.total).toBe(0);

    await service.consume("oracle:submit", "user:peeker", 1);
    const after = await service.peek("oracle:submit", "user:peeker");
    expect(after.total).toBe(1);

    // Peek again — total should still be 1 (not incremented)
    const again = await service.peek("oracle:submit", "user:peeker");
    expect(again.total).toBe(1);
  });

  it("resetQuota clears the actor's usage", async () => {
    service.registerPolicy({
      resource: "compute:job",
      limit: 2,
      windowMs: 60_000,
      description: "reset test",
    });

    await service.consume("compute:job", "user:admin-reset", 2);
    await service.resetQuota("compute:job", "user:admin-reset");
    const result = await service.consume("compute:job", "user:admin-reset", 1);
    expect(result.allowed).toBe(true);
    expect(result.total).toBe(1);
  });

  it("getUsageSummary returns sorted entries", async () => {
    service.registerPolicy({
      resource: "ai:tokens",
      limit: 500,
      windowMs: 3_600_000,
      description: "ai summary test",
    });

    await service.consume("ai:tokens", "user:light", 10);
    await service.consume("ai:tokens", "user:heavy", 100);

    const summary = await service.getUsageSummary("ai:tokens");
    expect(summary.length).toBeGreaterThanOrEqual(2);
    expect(summary[0].total).toBeGreaterThanOrEqual(summary[1].total);
  });

  it("listPolicies returns all default policies", () => {
    const policies = service.listPolicies();
    expect(policies.length).toBeGreaterThanOrEqual(DEFAULT_QUOTA_POLICIES.length);
    const resources = policies.map((p) => p.resource);
    expect(resources).toContain("ai:tokens");
    expect(resources).toContain("compute:job");
    expect(resources).toContain("oracle:submit");
  });

  it("registerPolicy overrides existing policy", () => {
    service.registerPolicy({
      resource: "ai:tokens",
      limit: 9999,
      windowMs: 60_000,
      description: "overridden",
    });
    const policy = service.getPolicy("ai:tokens");
    expect(policy?.limit).toBe(9999);
    expect(policy?.description).toBe("overridden");
  });

  it("accumulates cost correctly across multiple partial consumes", async () => {
    service.registerPolicy({
      resource: "storage:upload",
      limit: 100,
      windowMs: 60_000,
      description: "upload accumulate",
    });

    await service.consume("storage:upload", "user:uploads", 30);
    await service.consume("storage:upload", "user:uploads", 30);
    const result = await service.consume("storage:upload", "user:uploads", 30);
    expect(result.total).toBe(90);
    expect(result.remaining).toBe(10);
    expect(result.allowed).toBe(true);

    const blocked = await service.consume("storage:upload", "user:uploads", 15);
    expect(blocked.allowed).toBe(false);
  });
});
