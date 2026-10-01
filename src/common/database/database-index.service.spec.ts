import { DataSource } from "typeorm";
import { DatabaseIndexService } from "./database-index.service";

describe("DatabaseIndexService", () => {
  const makeDataSource = () => ({ query: jest.fn().mockResolvedValue([]) });

  const statements = (dataSource: { query: jest.Mock }): string[] =>
    dataSource.query.mock.calls.map(([statement]) => String(statement));

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe("ensureTrigramSearchSupport", () => {
    it("installs the extensions the fuzzy search indexes need", async () => {
      const dataSource = makeDataSource();
      const service = new DatabaseIndexService(
        dataSource as unknown as DataSource,
      );

      await expect(service.ensureTrigramSearchSupport()).resolves.toBe(true);

      expect(statements(dataSource)).toEqual([
        'CREATE EXTENSION IF NOT EXISTS "pg_trgm"',
        'CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"',
      ]);
    });

    it("reports failure instead of throwing when the role cannot create extensions", async () => {
      const dataSource = makeDataSource();
      dataSource.query.mockRejectedValue(
        Object.assign(new Error("permission denied to create extension"), {
          code: "42501",
        }),
      );
      const service = new DatabaseIndexService(
        dataSource as unknown as DataSource,
      );

      await expect(service.ensureTrigramSearchSupport()).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("createRecommendedIndexes", () => {
    it("uses the raw DDL for the trigram indexes and the generic form for the rest", async () => {
      const dataSource = makeDataSource();
      const service = new DatabaseIndexService(
        dataSource as unknown as DataSource,
      );

      await service.createRecommendedIndexes();

      const sql = statements(dataSource).join("\n");
      expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
      expect(sql).toContain(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_portfolio_assets_ticker_trgm" ON "portfolio_assets" USING gin ("ticker" gin_trgm_ops);',
      );
      expect(sql).toContain(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_portfolio_assets_name_trgm" ON "portfolio_assets" USING gin ("name" gin_trgm_ops);',
      );
      expect(sql).toContain(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_portfolio_assets_ticker_lower" ON "portfolio_assets" (LOWER("ticker"));',
      );
      expect(sql).toContain(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_wallet_created_composite ON users (wallet_address, created_at);",
      );
    });

    it("keeps going when one index fails", async () => {
      const dataSource = makeDataSource();
      dataSource.query.mockImplementation(async (statement: string) => {
        if (String(statement).includes("IDX_portfolio_assets_name_trgm")) {
          throw new Error("permission denied for table portfolio_assets");
        }

        return [];
      });
      const service = new DatabaseIndexService(
        dataSource as unknown as DataSource,
      );

      await expect(service.createRecommendedIndexes()).resolves.toBeUndefined();

      const sql = statements(dataSource).join("\n");
      expect(sql).toContain("IDX_portfolio_assets_ticker_lower");
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
