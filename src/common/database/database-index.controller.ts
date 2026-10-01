import {
  Controller,
  Get,
  Post,
  HttpCode,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import { DatabaseIndexService } from "./database-index.service";
import {
  IndexFragmentation,
  MissingForeignKeyIndex,
} from "./database-index.service";

/**
 * Admin endpoints for database index health diagnostics.
 *
 * These read-only endpoints are restricted to admin/ops users and provide
 * visibility into index fragmentation and missing foreign key indexes.
 */
@Controller("api/v1/admin/database")
export class DatabaseIndexController {
  constructor(private readonly indexService: DatabaseIndexService) {}

  /**
   * GET /api/v1/admin/database/index-health
   * Run comprehensive index health diagnostic.
   *
   * Returns fragmentation analysis and missing FK index detection.
   * No locks are acquired; this is a safe read-only operation.
   */
  @Get("index-health")
  @HttpCode(200)
  async getIndexHealth(): Promise<{
    fragmentation: IndexFragmentation[];
    missingIndexes: MissingForeignKeyIndex[];
    summary: {
      totalFragmentedIndexes: number;
      highSeverityFragmentation: number;
      totalMissingIndexes: number;
      criticalMissingIndexes: number;
    };
    scanTime: string;
  }> {
    const startTime = Date.now();
    const result = await this.indexService.runIndexHealthDiagnostic();
    const scanTime = ((Date.now() - startTime) / 1000).toFixed(2);

    return {
      ...result,
      scanTime: `${scanTime}s`,
    };
  }

  /**
   * GET /api/v1/admin/database/index-fragmentation
   * Get index fragmentation report.
   *
   * Shows which indexes have excessive bloat and recommendations for REINDEX.
   */
  @Get("index-fragmentation")
  @HttpCode(200)
  async getFragmentationReport(): Promise<{
    indexes: IndexFragmentation[];
    summary: {
      total: number;
      high: number;
      medium: number;
      low: number;
    };
  }> {
    const indexes = await this.indexService.checkIndexFragmentation();

    return {
      indexes,
      summary: {
        total: indexes.length,
        high: indexes.filter((i) => i.severity === "HIGH").length,
        medium: indexes.filter((i) => i.severity === "MEDIUM").length,
        low: indexes.filter((i) => i.severity === "LOW").length,
      },
    };
  }

  /**
   * GET /api/v1/admin/database/missing-fk-indexes
   * Get report of unindexed foreign keys.
   *
   * Foreign keys without indexes cause full table scans during joins
   * and inefficient cascading deletes.
   */
  @Get("missing-fk-indexes")
  @HttpCode(200)
  async getMissingForeignKeyIndexes(): Promise<{
    indexes: MissingForeignKeyIndex[];
    summary: {
      total: number;
      critical: number;
      high: number;
    };
  }> {
    const indexes = await this.indexService.detectMissingForeignKeyIndexes();

    return {
      indexes,
      summary: {
        total: indexes.length,
        critical: indexes.filter((i) => i.severity === "CRITICAL").length,
        high: indexes.filter((i) => i.severity === "HIGH").length,
      },
    };
  }

  /**
   * POST /api/v1/admin/database/analyze-indexes
   * Analyze all indexes and provide optimization recommendations.
   *
   * Returns a complete index analysis report with usage statistics
   * and recommendations for each index.
   */
  @Post("analyze-indexes")
  @HttpCode(200)
  async analyzeIndexes(): Promise<any> {
    const analysis = await this.indexService.analyzeIndexes();

    return {
      indexes: analysis,
      summary: {
        total: analysis.length,
        used: analysis.filter((i) => i.isUsed).length,
        unused: analysis.filter((i) => !i.isUsed).length,
        highUsage: analysis.filter((i) => i.scanCount > 1000).length,
      },
    };
  }
}
