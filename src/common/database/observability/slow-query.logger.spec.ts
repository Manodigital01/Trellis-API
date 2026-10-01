import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { SlowQueryLogger } from "./slow-query.logger";

describe("SlowQueryLogger", () => {
  let logger: SlowQueryLogger;

  beforeEach(async () => {
    delete process.env.SLOW_QUERY_THRESHOLD_MS;
    delete process.env.MAX_STORED_SLOW_QUERIES;
    const module: TestingModule = await Test.createTestingModule({
      providers: [SlowQueryLogger],
    }).compile();
    logger = module.get(SlowQueryLogger);
  });

  it("uses the 500ms default threshold required for production diagnostics", () => {
    logger.logSlowQuery(499, "SELECT 1");
    logger.logSlowQuery(500, "SELECT 2");
    expect(logger.getSlowQueries()).toHaveLength(1);
    expect(logger.getSlowQueries()[0].executionTime).toBe(500);
  });

  describe("logSlowQuery", () => {
    it("stores slow queries", () => {
      logger.logSlowQuery(1500, "SELECT * FROM users WHERE id = ?");
      const slow = logger.getSlowQueries();
      expect(slow).toHaveLength(1);
      expect(slow[0].executionTime).toBe(1500);
    });

    it("does not store fast queries", () => {
      logger.logSlowQuery(10, "SELECT 1");
      const slow = logger.getSlowQueries();
      expect(slow).toHaveLength(0);
    });

    it("returns top slow queries sorted by time", () => {
      logger.logSlowQuery(2000, "query1");
      logger.logSlowQuery(5000, "query2");
      const top = logger.getTopSlowQueries(1);
      expect(top[0].executionTime).toBe(5000);
    });
  });

  describe("getStats", () => {
    it("returns zero stats when empty", () => {
      expect(logger.getStats()).toEqual({
        total: 0,
        avgExecutionTime: 0,
        maxExecutionTime: 0,
      });
    });

    it("returns stats when queries exist", () => {
      logger.logSlowQuery(1000, "query");
      logger.logSlowQuery(3000, "query2");
      const stats = logger.getStats();
      expect(stats.total).toBe(2);
      expect(stats.maxExecutionTime).toBe(3000);
      expect(stats.avgExecutionTime).toBe(2000);
    });
  });
});
