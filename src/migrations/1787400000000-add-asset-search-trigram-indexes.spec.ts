import { QueryRunner } from "typeorm";
import { AddAssetSearchTrigramIndexes1787400000000 } from "src/migrations/1787400000000-add-asset-search-trigram-indexes";

describe("AddAssetSearchTrigramIndexes1787400000000", () => {
  const queryRunner = {
    query: jest.fn().mockResolvedValue(undefined),
  } as unknown as QueryRunner;
  const migration = new AddAssetSearchTrigramIndexes1787400000000();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const statements = (mock: jest.Mock): string[] =>
    mock.mock.calls.map(([statement]) => String(statement));

  it("enables the extensions the tolerant stage depends on", async () => {
    await migration.up(queryRunner);

    const sql = statements(queryRunner.query as jest.Mock).join("\n");
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"');
  });

  it("creates the trigram and expression indexes idempotently", async () => {
    await migration.up(queryRunner);

    const sql = statements(queryRunner.query as jest.Mock).join("\n");
    expect(sql).toContain('"IDX_portfolio_assets_ticker_trgm"');
    expect(sql).toContain('USING gin ("ticker" gin_trgm_ops)');
    expect(sql).toContain('"IDX_portfolio_assets_name_trgm"');
    expect(sql).toContain('USING gin ("name" gin_trgm_ops)');
    expect(sql).toContain('"IDX_portfolio_assets_ticker_lower"');
    expect(sql).toContain('(LOWER("ticker"))');

    for (const statement of statements(queryRunner.query as jest.Mock)) {
      if (statement.includes("CREATE INDEX")) {
        expect(statement).toContain("IF NOT EXISTS");
      }
    }
  });

  it("drops the indexes but never the extensions on revert", async () => {
    await migration.down(queryRunner);

    const sql = statements(queryRunner.query as jest.Mock).join("\n");
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_portfolio_assets_ticker_lower"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_portfolio_assets_name_trgm"');
    expect(sql).toContain('DROP INDEX IF EXISTS "IDX_portfolio_assets_ticker_trgm"');
    expect(sql).not.toContain("DROP EXTENSION");
  });
});
