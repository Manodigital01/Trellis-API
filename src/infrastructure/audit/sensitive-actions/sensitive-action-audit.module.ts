import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SensitiveActionEvent } from "../entities/sensitive-action-event.entity";
import { SensitiveActionChainHead } from "../entities/sensitive-action-chain-head.entity";
import { SensitiveActionAuditController } from "./sensitive-action-audit.controller";
import { SensitiveActionAuditService } from "./sensitive-action-audit.service";

/**
 * Audit-grade trail for sensitive user and maintainer actions.
 *
 * Exports `SensitiveActionAuditService` so domain services (payments,
 * reconciliation, access control) can record events at the boundary where the
 * action happens instead of reconstructing them from request logs.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SensitiveActionEvent, SensitiveActionChainHead])],
  controllers: [SensitiveActionAuditController],
  providers: [SensitiveActionAuditService],
  exports: [SensitiveActionAuditService],
})
export class SensitiveActionAuditModule {}
