import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Between, LessThan, MoreThanOrEqual, Repository } from "typeorm";
import { MaintainerAggregateMetric } from "./entities/maintainer-aggregate-metric.entity";
import {
  calculateLatencyStats,
  getDailySalt,
  getPrivacyBoundarySpecification,
  PrivacyBoundarySpec,
  RawTelemetryEvent,
  SanitizedTelemetryEvent,
  sanitizeTelemetryEvent,
  truncateToDay,
  truncateToHour,
} from "./privacy/privacy-boundary.definition";
import {
  MetricGranularity,
  QueryMaintainerInsightsDto,
} from "./dto/maintainer-insights.dto";

interface AggregationGroup {
  dateBucket: Date;
  granularity: "hourly" | "daily";
  operation: string;
  route: string;
  statusCategory: string;
  statusCode: number;
  errorCategory: string;
  clientType: string;
  network: string;
  actorType: string;
  totalEvents: number;
  successCount: number;
  failureCount: number;
  actorHashes: Set<string>;
  latencies: number[];
  errorBreakdown: Record<string, number>;
}

@Injectable()
export class MaintainerInsightsService {
  private readonly logger = new Logger(MaintainerInsightsService.name);

  // In-memory ephemeral buffer for events prior to periodic rollup
  private readonly ephemeralBuffer: SanitizedTelemetryEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 10000;

  // Retention configuration
  private readonly hourlyRetentionDays: number;
  private readonly dailyRetentionDays: number;

  constructor(
    @InjectRepository(MaintainerAggregateMetric)
    private readonly metricRepo: Repository<MaintainerAggregateMetric>,
  ) {
    this.hourlyRetentionDays = Number(process.env.ANALYTICS_HOURLY_RETENTION_DAYS) || 30;
    this.dailyRetentionDays = Number(process.env.ANALYTICS_DAILY_RETENTION_DAYS) || 365;
  }

  /**
   * Record a raw protocol operation event.
   * Event is immediately sanitized: raw IDs, secrets, and payloads are discarded.
   */
  recordEvent(rawEvent: RawTelemetryEvent): SanitizedTelemetryEvent {
    const salt = getDailySalt(new Date());
    const sanitized = sanitizeTelemetryEvent(rawEvent, salt);

    if (this.ephemeralBuffer.length >= this.MAX_BUFFER_SIZE) {
      // Evict oldest 10% to prevent unbounded growth if rollup lags
      this.ephemeralBuffer.splice(0, Math.floor(this.MAX_BUFFER_SIZE * 0.1));
      this.logger.warn("Ephemeral analytics buffer reached capacity; evicted oldest 10%");
    }

    this.ephemeralBuffer.push(sanitized);
    return sanitized;
  }

  /**
   * Aggregate in-memory ephemeral events into persistent hourly aggregate metric records.
   * Clears processed events from the buffer.
   */
  async flushAndAggregate(
    targetBucketDate?: Date,
    granularity: "hourly" | "daily" = "hourly",
  ): Promise<{ processed: number; aggregatesCreated: number }> {
    if (this.ephemeralBuffer.length === 0) {
      return { processed: 0, aggregatesCreated: 0 };
    }

    // Drain buffer
    const eventsToProcess = [...this.ephemeralBuffer];
    this.ephemeralBuffer.length = 0;

    const groups = new Map<string, AggregationGroup>();

    for (const evt of eventsToProcess) {
      const bucketDate = targetBucketDate
        ? (granularity === "hourly" ? truncateToHour(targetBucketDate) : truncateToDay(targetBucketDate))
        : (granularity === "hourly" ? truncateToHour(new Date(evt.timeBucket)) : truncateToDay(new Date(evt.timeBucket)));

      const groupKey = [
        bucketDate.toISOString(),
        granularity,
        evt.operation,
        evt.route,
        evt.statusCategory,
        evt.statusCode,
        evt.errorCategory,
        evt.clientType,
        evt.network,
        evt.actorType,
      ].join("::");

      let group = groups.get(groupKey);
      if (!group) {
        group = {
          dateBucket: bucketDate,
          granularity,
          operation: evt.operation,
          route: evt.route,
          statusCategory: evt.statusCategory,
          statusCode: evt.statusCode,
          errorCategory: evt.errorCategory,
          clientType: evt.clientType,
          network: evt.network,
          actorType: evt.actorType,
          totalEvents: 0,
          successCount: 0,
          failureCount: 0,
          actorHashes: new Set<string>(),
          latencies: [],
          errorBreakdown: {},
        };
        groups.set(groupKey, group);
      }

      group.totalEvents += 1;
      if (evt.statusCategory === "2xx") {
        group.successCount += 1;
      } else {
        group.failureCount += 1;
      }

      if (evt.actorHash) {
        group.actorHashes.add(evt.actorHash);
      }

      if (typeof evt.latencyMs === "number" && evt.latencyMs >= 0) {
        group.latencies.push(evt.latencyMs);
      }

      if (evt.errorCategory && evt.errorCategory !== "NONE") {
        group.errorBreakdown[evt.errorCategory] =
          (group.errorBreakdown[evt.errorCategory] || 0) + 1;
      }
    }

    let aggregatesCreated = 0;

    for (const group of groups.values()) {
      const stats = calculateLatencyStats(group.latencies);

      const metric = this.metricRepo.create({
        dateBucket: group.dateBucket,
        granularity: group.granularity,
        operation: group.operation,
        route: group.route,
        statusCategory: group.statusCategory,
        statusCode: group.statusCode,
        errorCategory: group.errorCategory,
        clientType: group.clientType,
        network: group.network,
        actorType: group.actorType,
        totalEvents: group.totalEvents,
        successCount: group.successCount,
        failureCount: group.failureCount,
        uniqueActorsCount: group.actorHashes.size,
        avgLatencyMs: stats.avgMs,
        minLatencyMs: stats.minMs,
        maxLatencyMs: stats.maxMs,
        p50LatencyMs: stats.p50Ms,
        p90LatencyMs: stats.p90Ms,
        p99LatencyMs: stats.p99Ms,
        errorBreakdown: group.errorBreakdown,
      });

      await this.metricRepo.save(metric);
      aggregatesCreated++;
    }

    this.logger.log(
      `Aggregated ${eventsToProcess.length} events into ${aggregatesCreated} metrics records (${granularity})`,
    );

    return { processed: eventsToProcess.length, aggregatesCreated };
  }

  /**
   * Roll up hourly metrics of a past day into daily aggregate metric records.
   */
  async rollUpDailyMetrics(targetDay?: Date): Promise<number> {
    const day = targetDay ? truncateToDay(targetDay) : truncateToDay(new Date(Date.now() - 86400000));
    const nextDay = new Date(day.getTime() + 86400000);

    const hourlyRecords = await this.metricRepo.find({
      where: {
        granularity: "hourly",
        dateBucket: Between(day, nextDay),
      },
    });

    if (hourlyRecords.length === 0) {
      return 0;
    }

    const dailyGroups = new Map<string, MaintainerAggregateMetric>();

    for (const rec of hourlyRecords) {
      const key = [
        rec.operation,
        rec.route,
        rec.statusCategory,
        rec.statusCode,
        rec.errorCategory,
        rec.clientType,
        rec.network,
        rec.actorType,
      ].join("::");

      let existing = dailyGroups.get(key);
      if (!existing) {
        existing = this.metricRepo.create({
          dateBucket: day,
          granularity: "daily",
          operation: rec.operation,
          route: rec.route,
          statusCategory: rec.statusCategory,
          statusCode: rec.statusCode,
          errorCategory: rec.errorCategory,
          clientType: rec.clientType,
          network: rec.network,
          actorType: rec.actorType,
          totalEvents: 0,
          successCount: 0,
          failureCount: 0,
          uniqueActorsCount: 0,
          avgLatencyMs: 0,
          minLatencyMs: rec.minLatencyMs,
          maxLatencyMs: rec.maxLatencyMs,
          p50LatencyMs: rec.p50LatencyMs,
          p90LatencyMs: rec.p90LatencyMs,
          p99LatencyMs: rec.p99LatencyMs,
          errorBreakdown: {},
        });
        dailyGroups.set(key, existing);
      }

      existing.totalEvents += rec.totalEvents;
      existing.successCount += rec.successCount;
      existing.failureCount += rec.failureCount;
      existing.uniqueActorsCount = Math.max(existing.uniqueActorsCount, rec.uniqueActorsCount);
      existing.minLatencyMs = Math.min(existing.minLatencyMs, rec.minLatencyMs);
      existing.maxLatencyMs = Math.max(existing.maxLatencyMs, rec.maxLatencyMs);

      // Merge error breakdown
      if (rec.errorBreakdown) {
        for (const [cat, cnt] of Object.entries(rec.errorBreakdown)) {
          existing.errorBreakdown[cat] = (existing.errorBreakdown[cat] || 0) + cnt;
        }
      }
    }

    const saved = await this.metricRepo.save(Array.from(dailyGroups.values()));
    return saved.length;
  }

  /**
   * Query filtered aggregated metric time series.
   */
  async getTimeseries(query: QueryMaintainerInsightsDto): Promise<{
    count: number;
    metrics: MaintainerAggregateMetric[];
  }> {
    const qb = this.metricRepo.createQueryBuilder("m");

    if (query.granularity) {
      qb.andWhere("m.granularity = :granularity", { granularity: query.granularity });
    }
    if (query.from) {
      qb.andWhere("m.dateBucket >= :from", { from: new Date(query.from) });
    }
    if (query.to) {
      qb.andWhere("m.dateBucket <= :to", { to: new Date(query.to) });
    }
    if (query.operation) {
      qb.andWhere("m.operation = :operation", { operation: query.operation });
    }
    if (query.route) {
      qb.andWhere("m.route = :route", { route: query.route });
    }
    if (query.statusCategory) {
      qb.andWhere("m.statusCategory = :statusCategory", { statusCategory: query.statusCategory });
    }
    if (query.errorCategory) {
      qb.andWhere("m.errorCategory = :errorCategory", { errorCategory: query.errorCategory });
    }
    if (query.clientType) {
      qb.andWhere("m.clientType = :clientType", { clientType: query.clientType });
    }
    if (query.network) {
      qb.andWhere("m.network = :network", { network: query.network });
    }

    qb.orderBy("m.dateBucket", "DESC");
    qb.skip(query.offset || 0);
    qb.take(query.limit || 100);

    const [metrics, count] = await qb.getManyAndCount();
    return { count, metrics };
  }

  /**
   * Get high-level Maintainer Insights Summary.
   */
  async getSummary(query: QueryMaintainerInsightsDto): Promise<{
    timestamp: string;
    window: { from?: string; to?: string; granularity: string };
    totals: {
      totalEvents: number;
      totalSuccess: number;
      totalFailure: number;
      successRatePercent: number;
      distinctActiveActors: number;
      avgLatencyMs: number;
    };
    byOperation: Record<
      string,
      { events: number; successRatePercent: number; avgLatencyMs: number }
    >;
    byErrorCategory: Record<string, number>;
    byClientType: Record<string, number>;
    byNetwork: Record<string, number>;
    trend: Array<{
      dateBucket: string;
      events: number;
      failures: number;
      avgLatencyMs: number;
    }>;
  }> {
    const timeseries = await this.getTimeseries({
      ...query,
      limit: 1000,
    });

    let totalEvents = 0;
    let totalSuccess = 0;
    let totalFailure = 0;
    let sumLatencyProduct = 0;
    let maxActors = 0;

    const byOperation: Record<
      string,
      { events: number; success: number; latencySum: number }
    > = {};
    const byErrorCategory: Record<string, number> = {};
    const byClientType: Record<string, number> = {};
    const byNetwork: Record<string, number> = {};
    const trendMap = new Map<string, { events: number; failures: number; latencySum: number }>();

    for (const m of timeseries.metrics) {
      totalEvents += m.totalEvents;
      totalSuccess += m.successCount;
      totalFailure += m.failureCount;
      sumLatencyProduct += (m.avgLatencyMs || 0) * m.totalEvents;
      maxActors += m.uniqueActorsCount || 0;

      // Operation grouping
      if (!byOperation[m.operation]) {
        byOperation[m.operation] = { events: 0, success: 0, latencySum: 0 };
      }
      byOperation[m.operation].events += m.totalEvents;
      byOperation[m.operation].success += m.successCount;
      byOperation[m.operation].latencySum += (m.avgLatencyMs || 0) * m.totalEvents;

      // Error categories
      if (m.errorCategory && m.errorCategory !== "NONE") {
        byErrorCategory[m.errorCategory] =
          (byErrorCategory[m.errorCategory] || 0) + m.failureCount;
      }
      if (m.errorBreakdown) {
        for (const [cat, cnt] of Object.entries(m.errorBreakdown)) {
          byErrorCategory[cat] = (byErrorCategory[cat] || 0) + cnt;
        }
      }

      // Client type
      byClientType[m.clientType] = (byClientType[m.clientType] || 0) + m.totalEvents;

      // Network
      byNetwork[m.network] = (byNetwork[m.network] || 0) + m.totalEvents;

      // Trend
      const bucketStr = m.dateBucket instanceof Date ? m.dateBucket.toISOString() : String(m.dateBucket);
      const existingTrend = trendMap.get(bucketStr) || { events: 0, failures: 0, latencySum: 0 };
      existingTrend.events += m.totalEvents;
      existingTrend.failures += m.failureCount;
      existingTrend.latencySum += (m.avgLatencyMs || 0) * m.totalEvents;
      trendMap.set(bucketStr, existingTrend);
    }

    const opResults: Record<
      string,
      { events: number; successRatePercent: number; avgLatencyMs: number }
    > = {};
    for (const [op, data] of Object.entries(byOperation)) {
      opResults[op] = {
        events: data.events,
        successRatePercent:
          data.events > 0 ? parseFloat(((data.success / data.events) * 100).toFixed(2)) : 100,
        avgLatencyMs:
          data.events > 0 ? parseFloat((data.latencySum / data.events).toFixed(2)) : 0,
      };
    }

    const trend = Array.from(trendMap.entries()).map(([dateBucket, data]) => ({
      dateBucket,
      events: data.events,
      failures: data.failures,
      avgLatencyMs:
        data.events > 0 ? parseFloat((data.latencySum / data.events).toFixed(2)) : 0,
    }));

    return {
      timestamp: new Date().toISOString(),
      window: {
        from: query.from,
        to: query.to,
        granularity: query.granularity || MetricGranularity.HOURLY,
      },
      totals: {
        totalEvents,
        totalSuccess,
        totalFailure,
        successRatePercent:
          totalEvents > 0 ? parseFloat(((totalSuccess / totalEvents) * 100).toFixed(2)) : 100,
        distinctActiveActors: maxActors,
        avgLatencyMs:
          totalEvents > 0 ? parseFloat((sumLatencyProduct / totalEvents).toFixed(2)) : 0,
      },
      byOperation: opResults,
      byErrorCategory,
      byClientType,
      byNetwork,
      trend,
    };
  }

  /**
   * Get Reliability report for maintainers (failure rates, bottlenecks, network comparisons).
   */
  async getReliability(query: QueryMaintainerInsightsDto): Promise<{
    overallReliabilityPercent: number;
    errorDistribution: Record<string, number>;
    highFailureOperations: Array<{
      operation: string;
      total: number;
      failures: number;
      failureRatePercent: number;
    }>;
    slowestOperations: Array<{
      operation: string;
      avgLatencyMs: number;
      p99LatencyMs: number;
    }>;
    networkReliability: Record<
      string,
      { total: number; failures: number; successRatePercent: number }
    >;
  }> {
    const summary = await this.getSummary(query);
    const timeseries = await this.getTimeseries({ ...query, limit: 1000 });

    const opFailureMap: Record<string, { total: number; failures: number }> = {};
    const opLatencyMap: Record<string, { latencies: number[]; maxP99: number }> = {};
    const netMap: Record<string, { total: number; failures: number }> = {};

    for (const m of timeseries.metrics) {
      if (!opFailureMap[m.operation]) {
        opFailureMap[m.operation] = { total: 0, failures: 0 };
      }
      opFailureMap[m.operation].total += m.totalEvents;
      opFailureMap[m.operation].failures += m.failureCount;

      if (!opLatencyMap[m.operation]) {
        opLatencyMap[m.operation] = { latencies: [], maxP99: 0 };
      }
      opLatencyMap[m.operation].latencies.push(m.avgLatencyMs || 0);
      opLatencyMap[m.operation].maxP99 = Math.max(
        opLatencyMap[m.operation].maxP99,
        m.p99LatencyMs || 0,
      );

      if (!netMap[m.network]) {
        netMap[m.network] = { total: 0, failures: 0 };
      }
      netMap[m.network].total += m.totalEvents;
      netMap[m.network].failures += m.failureCount;
    }

    const highFailureOperations = Object.entries(opFailureMap)
      .map(([operation, data]) => ({
        operation,
        total: data.total,
        failures: data.failures,
        failureRatePercent:
          data.total > 0 ? parseFloat(((data.failures / data.total) * 100).toFixed(2)) : 0,
      }))
      .filter((o) => o.failures > 0)
      .sort((a, b) => b.failureRatePercent - a.failureRatePercent);

    const slowestOperations = Object.entries(opLatencyMap)
      .map(([operation, data]) => {
        const avg = data.latencies.length > 0
          ? data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length
          : 0;
        return {
          operation,
          avgLatencyMs: parseFloat(avg.toFixed(2)),
          p99LatencyMs: data.maxP99,
        };
      })
      .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs);

    const networkReliability: Record<
      string,
      { total: number; failures: number; successRatePercent: number }
    > = {};
    for (const [net, data] of Object.entries(netMap)) {
      networkReliability[net] = {
        total: data.total,
        failures: data.failures,
        successRatePercent:
          data.total > 0
            ? parseFloat((((data.total - data.failures) / data.total) * 100).toFixed(2))
            : 100,
      };
    }

    return {
      overallReliabilityPercent: summary.totals.successRatePercent,
      errorDistribution: summary.byErrorCategory,
      highFailureOperations,
      slowestOperations,
      networkReliability,
    };
  }

  /**
   * Introspection: return formal privacy specification and boundaries.
   */
  getPrivacyBoundaries(): PrivacyBoundarySpec {
    return getPrivacyBoundarySpecification();
  }

  /**
   * Retention Cleaner: purge hourly metrics older than 30 days and daily metrics older than 365 days.
   */
  async purgeExpiredMetrics(): Promise<{ hourlyPurged: number; dailyPurged: number }> {
    const hourlyCutoff = new Date(Date.now() - this.hourlyRetentionDays * 86400000);
    const dailyCutoff = new Date(Date.now() - this.dailyRetentionDays * 86400000);

    const hourlyResult = await this.metricRepo.delete({
      granularity: "hourly",
      dateBucket: LessThan(hourlyCutoff),
    });

    const dailyResult = await this.metricRepo.delete({
      granularity: "daily",
      dateBucket: LessThan(dailyCutoff),
    });

    const hourlyPurged = hourlyResult.affected || 0;
    const dailyPurged = dailyResult.affected || 0;

    this.logger.log(
      `Retention policy enforced: purged ${hourlyPurged} expired hourly records (cutoff: ${hourlyCutoff.toISOString()}) and ${dailyPurged} daily records (cutoff: ${dailyCutoff.toISOString()})`,
    );

    return { hourlyPurged, dailyPurged };
  }

  /**
   * Return number of items in ephemeral buffer (for testing and health checks).
   */
  getBufferSize(): number {
    return this.ephemeralBuffer.length;
  }
}
