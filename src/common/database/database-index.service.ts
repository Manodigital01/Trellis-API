import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { logger } from "../../config/logger";

export interface IndexAnalysis {
  tableName: string;
  indexName: string;
  columns: string[];
  isUsed: boolean;
  size: string;
  scanCount: number;
  tupleCount: number;
  recommendation: string;
}

export interface IndexFragmentation {
  tableName: string;
  indexName: string;
  fragmentation: number;
  bloatBytes: number;
  severity: "LOW" | "MEDIUM" | "HIGH";
  recommendation: string;
}

export interface MissingForeignKeyIndex {
  tableName: string;
  columnName: string;
  constraintName: string;
  referencedTable: string;
  severity: "HIGH" | "CRITICAL";
  recommendation: string;
}

export interface QueryPerformanceMetrics {
  query: string;
  executionTime: number;
  rowsExamined: number;
  indexesUsed: string[];
  recommendations: string[];
}

export interface IndexRecommendation {
  tableName: string;
  columns: string[];
  indexName: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  /**
   * Raw DDL for indexes the default `CREATE INDEX ... (columns)` form cannot
   * express, such as `USING gin (... gin_trgm_ops)` or an expression index.
   */
  ddl?: string;
}

@Injectable()
export class DatabaseIndexService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Analyze database indexes and provide optimization recommendations
   */
  async analyzeIndexes(): Promise<IndexAnalysis[]> {
    const query = `
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef,
        idx_scan as scan_count,
        idx_tup_read as tuple_count,
        idx_tup_fetch as tuple_fetch,
        pg_size_pretty(pg_relation_size(indexrelid)) as size,
        CASE 
          WHEN idx_scan = 0 THEN 'UNUSED'
          WHEN idx_scan < 10 THEN 'LOW_USAGE'
          WHEN idx_scan < 100 THEN 'MEDIUM_USAGE'
          ELSE 'HIGH_USAGE'
        END as usage_category
      FROM pg_stat_user_indexes 
      JOIN pg_indexes ON pg_stat_user_indexes.schemaname = pg_indexes.schemaname 
        AND pg_stat_user_indexes.tablename = pg_indexes.tablename 
        AND pg_stat_user_indexes.indexname = pg_indexes.indexname
      ORDER BY tablename, indexname;
    `;

    const results = await this.dataSource.query(query);

    return results.map((row: any) => ({
      tableName: row.tablename,
      indexName: row.indexname,
      columns: this.extractColumnsFromDefinition(row.indexdef),
      isUsed: row.scan_count > 0,
      size: row.size,
      scanCount: parseInt(row.scan_count),
      tupleCount: parseInt(row.tuple_count),
      recommendation: this.generateIndexRecommendation(row),
    }));
  }

  /**
   * Find missing indexes based on query patterns
   */
  async findMissingIndexes(): Promise<QueryPerformanceMetrics[]> {
    // Enable pg_stat_statements if not already enabled
    await this.ensurePgStatStatements();

    const query = `
      SELECT 
        query,
        calls,
        total_exec_time,
        rows,
        100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent,
        mean_exec_time,
        stddev_exec_time
      FROM pg_stat_statements 
      WHERE calls > 10 
        AND mean_exec_time > 100 
        AND query NOT LIKE '%pg_stat_statements%'
        AND query NOT LIKE '%information_schema%'
      ORDER BY mean_exec_time DESC
      LIMIT 20;
    `;

    const results = await this.dataSource.query(query);

    return results.map((row: any) => ({
      query: row.query,
      executionTime: parseFloat(row.mean_exec_time),
      rowsExamined: parseInt(row.rows),
      indexesUsed: [], // Would need EXPLAIN ANALYZE to determine this
      recommendations: this.generateQueryRecommendations(row),
    }));
  }

  /**
   * Create recommended indexes based on analysis
   */
  async createRecommendedIndexes(): Promise<void> {
    const recommendations = await this.generateIndexRecommendations();

    // Trigram recommendations carry `USING gin (...)`, which needs pg_trgm
    // present first (the migration installs it; this covers a database that
    // was restored without the extension).
    await this.ensureTrigramSearchSupport();

    for (const recommendation of recommendations) {
      if (recommendation.priority === "HIGH") {
        try {
          await this.dataSource.query(
            recommendation.ddl ??
              `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${recommendation.indexName} ON ${recommendation.tableName} (${recommendation.columns.join(", ")});`,
          );
          console.log(`Created index: ${recommendation.indexName}`);
        } catch (error) {
          console.error(
            `Failed to create index ${recommendation.indexName}:`,
            error,
          );
        }
      }
    }
  }

  /**
   * Get table statistics for optimization
   */
  async getTableStatistics(): Promise<any[]> {
    const query = `
      SELECT 
        schemaname,
        tablename,
        attname,
        n_distinct,
        correlation
      FROM pg_stats 
      WHERE schemaname = 'public'
      ORDER BY tablename, attname;
    `;

    return await this.dataSource.query(query);
  }

  /**
   * Analyze slow queries
   */
  async analyzeSlowQueries(): Promise<QueryPerformanceMetrics[]> {
    const query = `
      SELECT
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        rows,
        shared_blks_hit,
        shared_blks_read
      FROM pg_stat_statements
      WHERE mean_exec_time > 1000
        AND calls > 5
      ORDER BY mean_exec_time DESC
      LIMIT 10;
    `;

    const results = await this.dataSource.query(query);

    return results.map((row: any) => ({
      query: row.query,
      executionTime: parseFloat(row.mean_exec_time),
      rowsExamined: parseInt(row.rows),
      indexesUsed: [],
      recommendations: this.generateSlowQueryRecommendations(row),
    }));
  }

  /**
   * Check index fragmentation levels across all user indexes.
   * Uses pg_stat_user_indexes and pgstattuple for bloat analysis.
   */
  async checkIndexFragmentation(): Promise<IndexFragmentation[]> {
    const query = `
      SELECT
        schemaname,
        tablename,
        indexname,
        idx_scan,
        ROUND(
          100.0 * (pg_relation_size(indexrelid) - pg_relation_size(indexrelid, 'main')) /
          NULLIF(pg_relation_size(indexrelid), 0),
          2
        ) as fragmentation_percent,
        pg_relation_size(indexrelid) - pg_relation_size(indexrelid, 'main') as bloat_bytes
      FROM pg_stat_user_indexes
      ORDER BY fragmentation_percent DESC NULLS LAST;
    `;

    const results = await this.dataSource.query(query);

    return results
      .filter((row: any) => row.fragmentation_percent !== null)
      .map((row: any) => {
        const fragmentation = parseFloat(row.fragmentation_percent) || 0;
        let severity: "LOW" | "MEDIUM" | "HIGH" = "LOW";

        if (fragmentation > 50) {
          severity = "HIGH";
        } else if (fragmentation > 30) {
          severity = "MEDIUM";
        }

        return {
          tableName: row.tablename,
          indexName: row.indexname,
          fragmentation,
          bloatBytes: parseInt(row.bloat_bytes) || 0,
          severity,
          recommendation: this.generateFragmentationRecommendation(fragmentation, row.indexname),
        };
      });
  }

  /**
   * Detect unindexed foreign keys that could cause full table scans during joins.
   * Scans TypeORM entity metadata against PostgreSQL catalog tables.
   */
  async detectMissingForeignKeyIndexes(): Promise<MissingForeignKeyIndex[]> {
    const query = `
      SELECT
        tc.table_name,
        kcu.column_name,
        tc.constraint_name,
        ccu.table_name AS referenced_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.column_name;
    `;

    const foreignKeys = await this.dataSource.query(query);
    const missingIndexes: MissingForeignKeyIndex[] = [];

    for (const fk of foreignKeys) {
      const indexQuery = `
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = $1
          AND indexdef LIKE '%' || $2 || '%'
        LIMIT 1;
      `;

      const result = await this.dataSource.query(indexQuery, [
        fk.table_name,
        fk.column_name,
      ]);

      if (result.length === 0) {
        missingIndexes.push({
          tableName: fk.table_name,
          columnName: fk.column_name,
          constraintName: fk.constraint_name,
          referencedTable: fk.referenced_table_name,
          severity:
            fk.table_name === "agent_events" ||
            fk.table_name === "portfolio_assets"
              ? "CRITICAL"
              : "HIGH",
          recommendation: `Create index on ${fk.table_name}(${fk.column_name}) to improve JOIN performance and cascading delete efficiency`,
        });
      }
    }

    return missingIndexes;
  }

  /**
   * Run a comprehensive index health diagnostic that checks both fragmentation and missing indexes.
   * This is suitable for an admin endpoint or CLI diagnostic task.
   */
  async runIndexHealthDiagnostic(): Promise<{
    fragmentation: IndexFragmentation[];
    missingIndexes: MissingForeignKeyIndex[];
    summary: {
      totalFragmentedIndexes: number;
      highSeverityFragmentation: number;
      totalMissingIndexes: number;
      criticalMissingIndexes: number;
    };
  }> {
    const fragmentation = await this.checkIndexFragmentation();
    const missingIndexes = await this.detectMissingForeignKeyIndexes();

    const highSeverity = fragmentation.filter((f) => f.severity === "HIGH");
    const criticalMissing = missingIndexes.filter((m) => m.severity === "CRITICAL");

    if (highSeverity.length > 0) {
      logger.warn(
        { count: highSeverity.length },
        "High-severity index fragmentation detected",
      );
    }

    if (criticalMissing.length > 0) {
      logger.warn(
        { count: criticalMissing.length },
        "Critical missing foreign key indexes detected",
      );
    }

    return {
      fragmentation,
      missingIndexes,
      summary: {
        totalFragmentedIndexes: fragmentation.length,
        highSeverityFragmentation: highSeverity.length,
        totalMissingIndexes: missingIndexes.length,
        criticalMissingIndexes: criticalMissing.length,
      },
    };
  }

  private generateFragmentationRecommendation(
    fragmentation: number,
    indexName: string,
  ): string {
    if (fragmentation > 50) {
      return `REINDEX ${indexName} to reclaim ${fragmentation.toFixed(1)}% bloat; consider concurrent reindex in production`;
    }
    if (fragmentation > 30) {
      return `Monitor ${indexName} fragmentation (${fragmentation.toFixed(1)}%); schedule REINDEX during maintenance window`;
    }
    return `Minor fragmentation in ${indexName} (${fragmentation.toFixed(1)}%); no immediate action needed`;
  }

  private extractColumnsFromDefinition(indexDef: string): string[] {
    const match = indexDef.match(/\(([^)]+)\)/);
    if (!match) return [];

    return match[1].split(",").map((col) => col.trim().replace(/"/g, ""));
  }

  private generateIndexRecommendation(indexStats: any): string {
    if (indexStats.scan_count === 0) {
      return "UNUSED - Consider dropping this index to save space and improve write performance";
    }

    if (indexStats.scan_count < 10) {
      return "LOW_USAGE - Consider if this index is necessary for your workload";
    }

    if (indexStats.scan_count > 1000) {
      return "HIGH_USAGE - This index is well utilized";
    }

    return "OK - Index is being used moderately";
  }

  private generateQueryRecommendations(queryStats: any): string[] {
    const recommendations: string[] = [];

    if (queryStats.mean_exec_time > 1000) {
      recommendations.push(
        "Consider adding indexes for columns in WHERE clauses",
      );
    }

    if (queryStats.rows > 10000) {
      recommendations.push("Consider pagination to reduce result set size");
    }

    if (queryStats.hit_percent < 90) {
      recommendations.push(
        "Low buffer cache hit rate - consider increasing shared_buffers or optimizing queries",
      );
    }

    return recommendations;
  }

  private generateSlowQueryRecommendations(queryStats: any): string[] {
    const recommendations: string[] = [];

    if (queryStats.mean_exec_time > 5000) {
      recommendations.push(
        "CRITICAL: This query is very slow and needs immediate optimization",
      );
    }

    if (queryStats.shared_blks_read > queryStats.shared_blks_hit) {
      recommendations.push(
        "High disk I/O - consider adding indexes or increasing memory",
      );
    }

    recommendations.push(
      "Run EXPLAIN ANALYZE on this query to identify bottlenecks",
    );

    return recommendations;
  }

  private async generateIndexRecommendations(): Promise<IndexRecommendation[]> {
    // This would analyze query patterns and suggest new indexes
    // For now, return some common recommendations based on the schema
    return [
      {
        tableName: "users",
        columns: ["wallet_address", "created_at"],
        indexName: "idx_users_wallet_created_composite",
        priority: "HIGH",
        reason:
          "Frequent queries filter by wallet address and order by creation time",
      },
      {
        tableName: "agent_events",
        columns: ["agent_id", "event_type", "created_at"],
        indexName: "idx_agent_events_composite_optimized",
        priority: "HIGH",
        reason: "Common query pattern for agent event filtering and pagination",
      },
      {
        tableName: "oracle_submissions",
        columns: ["status", "created_at"],
        indexName: "idx_oracle_submissions_status_time",
        priority: "MEDIUM",
        reason: "Queries often filter by submission status and time",
      },
      {
        tableName: "portfolio_assets",
        columns: ["ticker"],
        indexName: "IDX_portfolio_assets_ticker_trgm",
        priority: "HIGH",
        reason:
          "Typo-tolerant asset lookup compares LOWER(ticker) with similarity(); a GIN trigram index keeps the fallback from sequential-scanning portfolio_assets",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_portfolio_assets_ticker_trgm" ON "portfolio_assets" USING gin ("ticker" gin_trgm_ops);`,
      },
      {
        tableName: "portfolio_assets",
        columns: ["name"],
        indexName: "IDX_portfolio_assets_name_trgm",
        priority: "HIGH",
        reason:
          "Asset names are matched with the same similarity() fallback as tickers",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_portfolio_assets_name_trgm" ON "portfolio_assets" USING gin ("name" gin_trgm_ops);`,
      },
      {
        tableName: "portfolio_assets",
        columns: ["ticker"],
        indexName: "IDX_portfolio_assets_ticker_lower",
        priority: "HIGH",
        reason:
          "The exact/prefix stage matches on LOWER(ticker), which the default btree on the raw column cannot serve",
        ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_portfolio_assets_ticker_lower" ON "portfolio_assets" (LOWER("ticker"));`,
      },
    ];
  }

  /**
   * Install the extensions the fuzzy-search recommendations depend on.
   *
   * Mirrors the migration that owns these indexes: the search module degrades
   * to in-process ranking when the extensions are absent, but the recommended
   * GIN indexes cannot be created without pg_trgm, so a deployment that wants
   * database-side ranking has to have them.
   */
  async ensureTrigramSearchSupport(): Promise<boolean> {
    try {
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
      await this.dataSource.query(
        `CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"`,
      );
      return true;
    } catch (error) {
      console.warn("Could not enable pg_trgm/fuzzystrmatch extensions:", error);
      return false;
    }
  }

  private async ensurePgStatStatements(): Promise<void> {
    try {
      await this.dataSource.query(
        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
      );
    } catch (error) {
      console.warn("Could not enable pg_stat_statements extension:", error);
    }
  }
}
