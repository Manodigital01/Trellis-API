import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AgentEvent } from "./entities/agent-event.entity";
import { OracleSubmission } from "./entities/oracle-submission.entity";
import { ComputeResult } from "./entities/compute-result.entity";
import { ProvenanceRecord } from "./entities/provenance-record.entity";
import { ProvenanceService } from "./provenance.service";
import { ProvenanceController } from "./provenance.controller";
import { AuditLogService } from "./audit-log.service";
import { AuditLog } from "./entities/audit-log.entity";
import { ExportSigningService } from "./algorithms/export-signing.service";
import { CursorPaginationService } from "../../common/pagination/cursor-pagination.service";
import { PaginationModule } from "../../common/pagination/pagination.module";
import { AuditLogController } from "./audit-log.controller";
import { ActivityTimelineController } from "./activity-timeline.controller";
import { SensitiveActionEvent } from "./entities/sensitive-action-event.entity";
import { SensitiveActionAuditModule } from "./sensitive-actions/sensitive-action-audit.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuditLog,
      AgentEvent,
      OracleSubmission,
      ComputeResult,
      ProvenanceRecord,
      SensitiveActionEvent,
    ]),
    PaginationModule,
    SensitiveActionAuditModule,
  ],
  controllers: [ProvenanceController, AuditLogController, ActivityTimelineController],
  providers: [ProvenanceService, AuditLogService, ExportSigningService, CursorPaginationService],
  exports: [TypeOrmModule, ProvenanceService, AuditLogService, SensitiveActionAuditModule],
})
export class AuditModule {}
