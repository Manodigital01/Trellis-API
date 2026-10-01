import { QueryRunner } from "typeorm";
import { CreateBillingAuditRecords1787700000000 } from "src/migrations/1787700000000-create-billing-audit-records";

describe("CreateBillingAuditRecords1787700000000", () => {
  let queryRunner: QueryRunner;
  let migration: CreateBillingAuditRecords1787700000000;

  beforeEach(() => {
    queryRunner = {
      query: jest.fn().mockResolvedValue(undefined),
    } as unknown as QueryRunner;
    migration = new CreateBillingAuditRecords1787700000000();
  });

  function statements(): string[] {
    return (queryRunner.query as jest.Mock).mock.calls.map(([sql]) =>
      String(sql),
    );
  }

  it("creates the billing_audit_records table", async () => {
    await migration.up(queryRunner);

    const sql = statements().join("\n");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "billing_audit_records"');
    expect(sql).toContain('"lineItems" jsonb NOT NULL');
    expect(sql).toContain('"netAmountCents" integer NOT NULL DEFAULT 0');
  });

  // The proration line items are the whole point of the table, so the column
  // has to be jsonb rather than a text blob that every reader has to parse.
  it("stores the proration line items as structured jsonb", async () => {
    await migration.up(queryRunner);

    const sql = statements().join("\n");
    expect(sql).toMatch(/"lineItems"\s+jsonb/);
    expect(sql).toContain('"cycleStart" TIMESTAMP WITH TIME ZONE NOT NULL');
    expect(sql).toContain('"effectiveAt" TIMESTAMP WITH TIME ZONE NOT NULL');
  });

  // Without this the uuid default would be `uuid_generate_v4()`, which needs an
  // extension this migration does not create.
  it("defaults the primary key to gen_random_uuid and enables pgcrypto", async () => {
    await migration.up(queryRunner);

    const sql = statements().join("\n");
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    expect(sql).toContain('DEFAULT gen_random_uuid()');
    expect(sql).not.toContain("uuid_generate_v4()");
  });

  it("indexes both account read paths", async () => {
    await migration.up(queryRunner);

    const sql = statements().join("\n");
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_billing_audit_records_account_effective"',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_billing_audit_records_account_created"',
    );
  });

  it("drops the indexes before the table", async () => {
    await migration.down(queryRunner);

    const calls = statements();
    const dropIndex = calls.findIndex((s) => s.includes("DROP INDEX"));
    const dropTable = calls.findIndex((s) => s.includes("DROP TABLE"));
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(dropTable).toBeGreaterThan(dropIndex);
  });

  it("reverses idempotently so a re-run cannot fail on a missing object", async () => {
    await migration.down(queryRunner);

    const sql = statements().join("\n");
    expect(sql).toContain("DROP INDEX IF EXISTS");
    expect(sql).toContain("DROP TABLE IF EXISTS");
  });
});
