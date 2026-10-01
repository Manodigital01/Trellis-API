import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { MaintainerInsightsService } from "./maintainer-insights.service";
import { DistributedLock } from "../../infrastructure/distributed-lock/distributed-lock.decorator";

/**
 * Background aggregation and retention lifecycle worker for Maintainer Insights.
 *
 * Jobs:
 * 1. Hourly Aggregation: Flushes ephemeral events into hourly aggregate metric records.
 * 2. Daily Rollup: Consolidates hourly records into daily trend records.
 * 3. Retention Cleanup: Enforces retention boundaries (30-day hourly, 365-day daily).
 */
@Injectable()
export class MaintainerInsightsJobService {
  private readonly logger = new Logger(MaintainerInsightsJobService.name);

  constructor(
    private readonly insightsService: MaintainerInsightsService,
  ) {}

  /**
   * Hourly aggregation job: flushes and rolls up buffered events into hourly buckets.
   * Runs at minute 1 of every hour.
   */
  @Cron("1 * * * *")
  @DistributedLock("maintainer-insights:hourly-aggregation", 10 * 60_000)
  async handleHourlyAggregation(): Promise<void> {
    this.logger.debug("Executing scheduled hourly maintainer insights aggregation...");
    try {
      const result = await this.insightsService.flushAndAggregate(undefined, "hourly");
      this.logger.log(
        `Scheduled hourly aggregation completed: processed ${result.processed} events, created ${result.aggregatesCreated} metric records`,
      );
    } catch (err: any) {
      this.logger.error(`Error executing hourly insights aggregation: ${err.message}`, err.stack);
    }
  }

  /**
   * Daily rollup job: consolidates previous day's hourly records into daily summaries.
   * Runs daily at 01:05 UTC.
   */
  @Cron("5 1 * * *")
  @DistributedLock("maintainer-insights:daily-rollup", 30 * 60_000)
  async handleDailyRollup(): Promise<void> {
    this.logger.debug("Executing scheduled daily maintainer insights rollup...");
    try {
      const rolledUpCount = await this.insightsService.rollUpDailyMetrics();
      this.logger.log(`Scheduled daily rollup completed: ${rolledUpCount} daily records created/updated`);
    } catch (err: any) {
      this.logger.error(`Error executing daily insights rollup: ${err.message}`, err.stack);
    }
  }

  /**
   * Retention enforcement cleaner: purges expired aggregate metrics.
   * Runs daily at 02:15 UTC.
   */
  @Cron("15 2 * * *")
  @DistributedLock("maintainer-insights:retention-cleanup", 30 * 60_000)
  async handleRetentionCleanup(): Promise<void> {
    this.logger.debug("Executing scheduled maintainer insights retention cleanup...");
    try {
      const purged = await this.insightsService.purgeExpiredMetrics();
      this.logger.log(
        `Retention cleanup completed: purged ${purged.hourlyPurged} hourly records, ${purged.dailyPurged} daily records`,
      );
    } catch (err: any) {
      this.logger.error(`Error executing insights retention cleanup: ${err.message}`, err.stack);
    }
  }
}
