import {
  MigrationSafetyRunner,
  MigrationPlan,
  PostMigrationCheck,
  MockQueryRunner,
} from "./migration-safety";

describe("Migration Safety Framework (Issue #51)", () => {
  const samplePlan: MigrationPlan = {
    migrationName: "1787313600000-create-module-registry",
    version: "1.0.0",
    description: "Create module registry tables and indexes",
    steps: [
      {
        name: "create_modules_table",
        table: "modules",
        operation: "CREATE_TABLE",
        isDestructive: false,
        reversible: true,
        sqlUp: 'CREATE TABLE "modules" ("id" uuid PRIMARY KEY);',
        sqlDown: 'DROP TABLE "modules";',
      },
      {
        name: "create_tenant_module_states",
        table: "tenant_module_states",
        operation: "CREATE_TABLE",
        isDestructive: false,
        reversible: true,
        sqlUp: 'CREATE TABLE "tenant_module_states" ("id" uuid PRIMARY KEY);',
        sqlDown: 'DROP TABLE "tenant_module_states";',
      },
    ],
  };

  describe("Dry Run Impact Simulation", () => {
    it("generates a comprehensive dry-run report before executing writes", async () => {
      const report = await MigrationSafetyRunner.dryRun(samplePlan);

      expect(report.migrationName).toBe("1787313600000-create-module-registry");
      expect(report.totalSteps).toBe(2);
      expect(report.destructiveSteps).toBe(0);
      expect(report.irreversibleSteps).toBe(0);
      expect(report.safeToProceed).toBe(true);
      expect(report.rollbackNotes).toHaveLength(2);
      expect(report.rollbackNotes[0]).toContain('DROP TABLE "modules";');
    });

    it("detects destructive and irreversible operations with critical warnings", async () => {
      const riskyPlan: MigrationPlan = {
        migrationName: "drop-legacy-portfolios",
        version: "2.0.0",
        description: "Drop legacy portfolio tables",
        steps: [
          {
            name: "drop_portfolios_v1",
            table: "portfolios_v1",
            operation: "DROP_TABLE",
            estimatedAffectedRecords: 500,
            isDestructive: true,
            reversible: false,
            sqlUp: 'DROP TABLE "portfolios_v1";',
            sqlDown: "",
          },
        ],
      };

      const report = await MigrationSafetyRunner.dryRun(riskyPlan);

      expect(report.destructiveSteps).toBe(1);
      expect(report.irreversibleSteps).toBe(1);
      expect(report.estimatedAffectedRecords).toBe(500);
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings[0]).toContain("[CRITICAL] Destructive operation");
      expect(report.rollbackNotes[0]).toContain("FORWARD-FIX REQUIRED");
    });

    it("inspects live record counts when queryRunner is provided", async () => {
      const mockRunner: MockQueryRunner = {
        query: async (sql: string) => {
          if (sql.includes("portfolios")) return [{ count: "1250" }];
          return [{ count: "0" }];
        },
      };

      const planWithTable: MigrationPlan = {
        migrationName: "migrate-portfolio-records",
        version: "1.1.0",
        description: "Transform portfolio assets",
        steps: [
          {
            name: "alter_portfolio_table",
            table: "portfolios",
            operation: "ALTER_TABLE",
            isDestructive: false,
            reversible: true,
            sqlUp: 'ALTER TABLE "portfolios" ADD COLUMN "currency" varchar(10);',
            sqlDown: 'ALTER TABLE "portfolios" DROP COLUMN "currency";',
          },
        ],
      };

      const report = await MigrationSafetyRunner.dryRun(planWithTable, mockRunner);

      expect(report.estimatedAffectedRecords).toBe(1250);
      expect(report.plannedOperations[0].recordsAffected).toBe(1250);
    });
  });

  describe("Post-Migration Consistency Validation", () => {
    it("reports allPassed: true when all validation checks succeed", async () => {
      const mockRunner: MockQueryRunner = {
        query: async (sql: string) => {
          if (sql.includes("COUNT(*)")) return [{ count: "0" }]; // 0 orphaned records
          return [];
        },
      };

      const checks: PostMigrationCheck[] = [
        {
          name: "no_orphaned_assets",
          description: "Verify all portfolio assets point to an existing portfolio",
          query: 'SELECT COUNT(*) as count FROM "portfolio_assets" WHERE "portfolioId" IS NULL;',
          validate: (result) => parseInt(result[0].count, 10) === 0,
          errorMessage: "Orphaned portfolio assets detected without parent portfolio.",
        },
      ];

      const checkResult = await MigrationSafetyRunner.executePostChecks(checks, mockRunner);

      expect(checkResult.allPassed).toBe(true);
      expect(checkResult.passedCount).toBe(1);
      expect(checkResult.failedCount).toBe(0);
      expect(checkResult.failures).toHaveLength(0);
    });

    it("detects post-migration inconsistencies and provides actionable error details", async () => {
      const mockRunner: MockQueryRunner = {
        query: async () => [{ count: "14" }], // 14 inconsistent records detected
      };

      const checks: PostMigrationCheck[] = [
        {
          name: "no_orphaned_assets",
          description: "Verify all portfolio assets point to an existing portfolio",
          query: 'SELECT COUNT(*) as count FROM "portfolio_assets" WHERE "portfolioId" IS NULL;',
          validate: (result) => parseInt(result[0].count, 10) === 0,
          errorMessage: "Orphaned portfolio assets detected without parent portfolio.",
        },
      ];

      const checkResult = await MigrationSafetyRunner.executePostChecks(checks, mockRunner);

      expect(checkResult.allPassed).toBe(false);
      expect(checkResult.passedCount).toBe(0);
      expect(checkResult.failedCount).toBe(1);
      expect(checkResult.failures[0].checkName).toBe("no_orphaned_assets");
      expect(checkResult.failures[0].error).toContain("Orphaned portfolio assets detected");
    });
  });
});
