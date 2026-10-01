import { QueryRunner } from "typeorm";
import { AddRefreshTokenFamily1787600000000 } from "src/migrations/1787600000000-add-refresh-token-family";

describe("AddRefreshTokenFamily1787600000000", () => {
  let queryRunner: QueryRunner;
  let migration: AddRefreshTokenFamily1787600000000;

  beforeEach(() => {
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
    migration = new AddRefreshTokenFamily1787600000000();
  });

  it("adds the familyId column and its index", async () => {
    await migration.up(queryRunner);

    const sql = (queryRunner.query as jest.Mock).mock.calls
      .map(([statement]) => String(statement))
      .join("\n");

    expect(sql).toContain('ALTER TABLE "refresh_tokens" ADD "familyId"');
    expect(sql).toContain('CREATE INDEX "IDX_refresh_tokens_family_id"');
  });

  // The column must be nullable: a NOT NULL column would fail to apply against
  // a table that already holds refresh tokens, which is the only state a real
  // upgrade ever starts from.
  it("keeps the column nullable so existing rows survive", async () => {
    await migration.up(queryRunner);

    const statements = (queryRunner.query as jest.Mock).mock.calls.map(([s]) => String(s));
    const alter = statements.find((s) => s.includes("familyId"));

    expect(alter).toBeDefined();
    expect(alter).not.toMatch(/NOT\s+NULL/i);
  });

  it("drops the index before the column", async () => {
    await migration.down(queryRunner);

    const calls = (queryRunner.query as jest.Mock).mock.calls.map(([s]) => String(s));
    const dropIndex = calls.findIndex((s) => s.includes("DROP INDEX"));
    const dropColumn = calls.findIndex((s) => s.includes("DROP COLUMN"));

    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(dropColumn).toBeGreaterThan(dropIndex);
  });

  it("reverses cleanly and is idempotent on the way down", async () => {
    await migration.down(queryRunner);
    const calls = (queryRunner.query as jest.Mock).mock.calls.map(([s]) => String(s));

    expect(calls.some((s) => s.includes("DROP INDEX IF EXISTS"))).toBe(true);
  });
});
