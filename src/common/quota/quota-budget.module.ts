import { Module, Global } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { QuotaBudgetService } from "./quota-budget.service";
import { QUOTA_BUDGET_REDIS } from "./quota-budget.constants";

/**
 * QuotaBudgetModule — provides the per-user budget ledger globally.
 *
 * Importing this module once in AppModule makes QuotaBudgetService available
 * for injection everywhere without re-importing.
 *
 * Issue: #65
 */
@Global()
@Module({
  providers: [
    {
      provide: QUOTA_BUDGET_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis | null => {
        const url = config.get<string>("REDIS_URL");
        if (!url) return null;
        return new Redis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 3000,
          keyPrefix: "", // QuotaBudgetService manages its own key prefix
        });
      },
    },
    QuotaBudgetService,
  ],
  exports: [QuotaBudgetService],
})
export class QuotaBudgetModule {}
