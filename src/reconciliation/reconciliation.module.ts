import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { TransactionDetailsService } from "./transaction-details.service";
import { HorizonPollingService } from "./horizon-polling.service";
import { DryRunReconciliationController } from "./dry-run-reconciliation.controller";
import { DryRunReconciliationService } from "./dry-run-reconciliation.service";
import { ReconciliationAudit } from "./entities/reconciliation-audit.entity";
import { ReconciliationInvoice } from "./entities/reconciliation-invoice.entity";
import { StellarTransaction } from "./entities/stellar-transaction.entity";
import { FeatureFlagsService } from "../config/feature-flags.service";

import { AuthModule } from "../core/auth/auth.module";
import { UserModule } from "../core/user/user.module";

@Module({
  imports: [
    AuthModule,
    UserModule,
    TypeOrmModule.forFeature([
      ReconciliationAudit,
      ReconciliationInvoice,
      StellarTransaction,
    ]),
    // Enables the scheduled dry-run safety net.
    ScheduleModule.forRoot(),
  ],
  controllers: [ReconciliationController, DryRunReconciliationController],
  providers: [
    ReconciliationService,
    HorizonPollingService,
    DryRunReconciliationService,
    TransactionDetailsService,
    FeatureFlagsService,
  ],
  exports: [ReconciliationService, DryRunReconciliationService, TransactionDetailsService],
})
export class ReconciliationModule {}
