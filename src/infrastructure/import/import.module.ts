import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { Portfolio } from '../../investment/portfolio/entities/portfolio.entity';
import { PortfolioAsset } from '../../investment/portfolio/entities/portfolio-asset.entity';
import { Transaction } from '../../investment/portfolio/entities/transaction.entity';
import { User } from '../../core/user/entities/user.entity';
import { ReconciliationInvoice } from '../../reconciliation/entities/reconciliation-invoice.entity';
import { AuthModule } from '../../core/auth/auth.module';
import { UserModule } from '../../core/user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Portfolio,
      PortfolioAsset,
      Transaction,
      User,
      ReconciliationInvoice,
    ]),
    AuthModule,
    UserModule,
  ],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
