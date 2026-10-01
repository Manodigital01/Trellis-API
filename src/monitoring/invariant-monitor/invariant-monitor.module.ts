import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { InvariantMonitorService } from "./invariant-monitor.service";
import { InvariantMonitorController } from "./invariant-monitor.controller";
import { InvariantReportEntity } from "./entities/invariant-report.entity";
import { User } from "src/core/user/entities/user.entity";
import { Wallet } from "src/core/auth/entities/wallet.entity";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";
import { PortfolioAsset } from "src/investment/portfolio/entities/portfolio-asset.entity";
import { Transaction } from "src/investment/portfolio/entities/transaction.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InvariantReportEntity,
      User,
      Wallet,
      Portfolio,
      PortfolioAsset,
      Transaction,
    ]),
  ],
  controllers: [InvariantMonitorController],
  providers: [InvariantMonitorService],
  exports: [InvariantMonitorService],
})
export class InvariantMonitorModule {}
