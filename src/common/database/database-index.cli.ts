import { Injectable } from "@nestjs/common";
import { Command } from "nestjs-command";
import { DatabaseIndexService } from "./database-index.service";
import { logger } from "../../config/logger";

/**
 * CLI commands for database index maintenance and diagnostics.
 *
 * Usage:
 *   npm run cli -- index-health-check
 *   npm run cli -- check-fragmentation
 *   npm run cli -- check-missing-fks
 *   npm run cli -- analyze-slow-queries
 */
@Injectable()
export class DatabaseIndexCliService {
  constructor(private readonly indexService: DatabaseIndexService) {}

  /**
   * Run comprehensive index health diagnostic.
   *
   * Command: npm run cli -- index-health-check
   */
  @Command({
    command: "index-health-check",
    describe: "Run comprehensive index health diagnostic",
  })
  async runHealthCheck(): Promise<void> {
    logger.info("Starting index health diagnostic...");

    try {
      const result = await this.indexService.runIndexHealthDiagnostic();

      console.log("\n═══════════════════════════════════════════════════════════════");
      console.log("📊 INDEX HEALTH DIAGNOSTIC REPORT");
      console.log("═══════════════════════════════════════════════════════════════\n");

      // Fragmentation report
      console.log("🔍 INDEX FRAGMENTATION ANALYSIS");
      console.log("───────────────────────────────────────────────────────────────");
      if (result.fragmentation.length === 0) {
        console.log("✅ No fragmented indexes detected");
      } else {
        result.fragmentation.forEach((idx) => {
          const icon =
            idx.severity === "HIGH"
              ? "🔴"
              : idx.severity === "MEDIUM"
                ? "🟡"
                : "🟢";
          console.log(
            `${icon} ${idx.tableName}.${idx.indexName}: ${idx.fragmentation.toFixed(1)}% bloat`,
          );
          console.log(`   └─ ${idx.recommendation}`);
        });
      }

      // Missing FK indexes
      console.log("\n🔗 UNINDEXED FOREIGN KEYS");
      console.log("───────────────────────────────────────────────────────────────");
      if (result.missingIndexes.length === 0) {
        console.log("✅ All foreign keys have indexes");
      } else {
        result.missingIndexes.forEach((fk) => {
          const icon = fk.severity === "CRITICAL" ? "🔴" : "🟠";
          console.log(
            `${icon} ${fk.tableName}(${fk.columnName}) → ${fk.referencedTable}`,
          );
          console.log(`   └─ ${fk.recommendation}`);
        });
      }

      // Summary
      console.log("\n📈 SUMMARY");
      console.log("───────────────────────────────────────────────────────────────");
      console.log(
        `Total fragmented indexes:    ${result.summary.totalFragmentedIndexes}`,
      );
      console.log(
        `High severity fragmentation: ${result.summary.highSeverityFragmentation}`,
      );
      console.log(
        `Total missing FK indexes:    ${result.summary.totalMissingIndexes}`,
      );
      console.log(
        `Critical missing indexes:    ${result.summary.criticalMissingIndexes}`,
      );
      console.log(
        "\n═══════════════════════════════════════════════════════════════\n",
      );

      logger.info("Index health diagnostic completed successfully");
    } catch (err) {
      logger.error({ error: err.message }, "Index health diagnostic failed");
      throw err;
    }
  }

  /**
   * Check index fragmentation levels.
   *
   * Command: npm run cli -- check-fragmentation
   */
  @Command({
    command: "check-fragmentation",
    describe: "Check index fragmentation levels",
  })
  async checkFragmentation(): Promise<void> {
    logger.info("Checking index fragmentation...");

    try {
      const indexes = await this.indexService.checkIndexFragmentation();

      console.log("\n📊 INDEX FRAGMENTATION REPORT");
      console.log("───────────────────────────────────────────────────────────────");

      if (indexes.length === 0) {
        console.log("✅ No indexes found or analyzed");
      } else {
        // Sort by severity
        const bySeverity = {
          HIGH: indexes.filter((i) => i.severity === "HIGH"),
          MEDIUM: indexes.filter((i) => i.severity === "MEDIUM"),
          LOW: indexes.filter((i) => i.severity === "LOW"),
        };

        Object.entries(bySeverity).forEach(([severity, items]) => {
          if (items.length > 0) {
            const icon = severity === "HIGH" ? "🔴" : severity === "MEDIUM" ? "🟡" : "🟢";
            console.log(`\n${icon} ${severity} SEVERITY (${items.length} indexes)`);
            items.forEach((idx) => {
              console.log(
                `  • ${idx.tableName}.${idx.indexName}: ${idx.fragmentation.toFixed(1)}% (${idx.bloatBytes} bytes)`,
              );
            });
          }
        });
      }

      console.log("\n───────────────────────────────────────────────────────────────\n");
      logger.info("Fragmentation check completed");
    } catch (err) {
      logger.error({ error: err.message }, "Fragmentation check failed");
      throw err;
    }
  }

  /**
   * Check for missing foreign key indexes.
   *
   * Command: npm run cli -- check-missing-fks
   */
  @Command({
    command: "check-missing-fks",
    describe: "Detect unindexed foreign keys",
  })
  async checkMissingForeignKeys(): Promise<void> {
    logger.info("Detecting unindexed foreign keys...");

    try {
      const missing = await this.indexService.detectMissingForeignKeyIndexes();

      console.log("\n🔗 UNINDEXED FOREIGN KEYS");
      console.log("───────────────────────────────────────────────────────────────");

      if (missing.length === 0) {
        console.log("✅ All foreign keys have proper indexes");
      } else {
        const bySeverity = {
          CRITICAL: missing.filter((m) => m.severity === "CRITICAL"),
          HIGH: missing.filter((m) => m.severity === "HIGH"),
        };

        Object.entries(bySeverity).forEach(([severity, items]) => {
          if (items.length > 0) {
            const icon = severity === "CRITICAL" ? "🔴" : "🟠";
            console.log(`\n${icon} ${severity} (${items.length} foreign keys)`);
            items.forEach((fk) => {
              console.log(
                `  • ${fk.tableName}(${fk.columnName}) → ${fk.referencedTable}`,
              );
              console.log(`    └─ Constraint: ${fk.constraintName}`);
            });
          }
        });

        console.log("\n⚠️  RECOMMENDED ACTIONS:");
        missing.forEach((fk) => {
          console.log(
            `  CREATE INDEX CONCURRENTLY idx_${fk.tableName}_${fk.columnName} ON ${fk.tableName}(${fk.columnName});`,
          );
        });
      }

      console.log("\n───────────────────────────────────────────────────────────────\n");
      logger.info("Missing FK check completed");
    } catch (err) {
      logger.error({ error: err.message }, "Missing FK check failed");
      throw err;
    }
  }

  /**
   * Analyze slow queries and provide index recommendations.
   *
   * Command: npm run cli -- analyze-slow-queries
   */
  @Command({
    command: "analyze-slow-queries",
    describe: "Analyze slow queries and recommend indexes",
  })
  async analyzeSlowQueries(): Promise<void> {
    logger.info("Analyzing slow queries...");

    try {
      const queries = await this.indexService.analyzeSlowQueries();

      console.log("\n🐌 SLOW QUERY ANALYSIS");
      console.log("───────────────────────────────────────────────────────────────");

      if (queries.length === 0) {
        console.log("✅ No slow queries detected");
      } else {
        queries.forEach((q, idx) => {
          console.log(`\n${idx + 1}. Query (${q.executionTime.toFixed(2)}ms)`);
          console.log(`   SQL: ${q.query.substring(0, 80)}...`);
          console.log(`   Rows examined: ${q.rowsExamined}`);
          if (q.recommendations.length > 0) {
            console.log("   📋 Recommendations:");
            q.recommendations.forEach((r) => console.log(`      • ${r}`));
          }
        });
      }

      console.log("\n───────────────────────────────────────────────────────────────\n");
      logger.info("Slow query analysis completed");
    } catch (err) {
      logger.error({ error: err.message }, "Slow query analysis failed");
      throw err;
    }
  }
}
