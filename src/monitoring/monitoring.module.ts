import { Module, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MonitoringController } from "./monitoring.controller";
import { MonitoringMetricsService } from "./monitoring-metrics.service";
import { SystemMetricsService } from "./system-metrics.service";
import { AlertRulesService } from "./alert-rules.service";
import { MetricsHistoryService } from "./metrics-history.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OperationalHealthController } from "./operational-health.controller";
import { OperationalHealthService } from "./operational-health.service";
import { StellarTransaction } from "../reconciliation/entities/stellar-transaction.entity";
import { ReconciliationInvoice } from "../reconciliation/entities/reconciliation-invoice.entity";
import { WebhookDeadLetter } from "../infrastructure/webhooks/entities/webhook-dead-letter.entity";
import { PartialFailure } from "./entities/partial-failure.entity";
import { PartialFailureController } from "./partial-failure.controller";
import { PartialFailureService } from "./partial-failure.service";
import { MaintainerAggregateMetric } from "./maintainer-insights/entities/maintainer-aggregate-metric.entity";
import { MaintainerInsightsController } from "./maintainer-insights/maintainer-insights.controller";
import { MaintainerInsightsService } from "./maintainer-insights/maintainer-insights.service";
import { MaintainerInsightsJobService } from "./maintainer-insights/maintainer-insights-job.service";

import { AuthModule } from "../core/auth/auth.module";
import { UserModule } from "../core/user/user.module";

/**
 * Comprehensive monitoring & metrics module.
 *
 * Wires together:
 *  - {@link MonitoringMetricsService} — facade over the shared Prometheus registry
 *  - {@link SystemMetricsService}    — periodic CPU/memory/disk sampling
 *  - {@link AlertRulesService}       — configurable threshold alerting
 *  - {@link MetricsHistoryService}   — retained historical KPI time series
 *  - {@link MonitoringController}    — /metrics, health, alerts, history, dashboard
 *  - {@link MaintainerInsightsService} — privacy-preserving usage & reliability analytics
 *
 * The timer-driven services are started in {@link onModuleInit} rather
 * than in their constructors so importing the module (e.g. in a unit test) does
 * not spawn background intervals.
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    UserModule,
    TypeOrmModule.forFeature([
      StellarTransaction,
      ReconciliationInvoice,
      WebhookDeadLetter,
      PartialFailure,
      MaintainerAggregateMetric,
    ]),
  ],
  controllers: [
    MonitoringController,
    OperationalHealthController,
    PartialFailureController,
    MaintainerInsightsController,
  ],
  providers: [
    MonitoringMetricsService,
    SystemMetricsService,
    AlertRulesService,
    MetricsHistoryService,
    OperationalHealthService,
    PartialFailureService,
    MaintainerInsightsService,
    MaintainerInsightsJobService,
  ],
  exports: [
    MonitoringMetricsService,
    SystemMetricsService,
    AlertRulesService,
    MetricsHistoryService,
    OperationalHealthService,
    PartialFailureService,
    MaintainerInsightsService,
    MaintainerInsightsJobService,
  ],
})
export class MonitoringModule implements OnModuleInit {
  constructor(
    private readonly systemMetrics: SystemMetricsService,
    private readonly alerts: AlertRulesService,
    private readonly history: MetricsHistoryService,
  ) {}

  onModuleInit(): void {
    this.systemMetrics.start();
    this.alerts.start();
    this.history.start();
  }
}
