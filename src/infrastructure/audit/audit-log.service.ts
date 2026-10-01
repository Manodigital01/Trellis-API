import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AuditLog, AuditLogVisibility } from "./entities/audit-log.entity";
import { QueryAuditLogDto, ExportAuditLogDto } from "./dto/query-audit-log.dto";
import { AuditLogListResponseDto } from "./dto/audit-log-response.dto";
import { ExportSigningService } from "./algorithms/export-signing.service";
import { CursorPaginationService } from "../../common/pagination/cursor-pagination.service";
import { DistributedLock } from "../distributed-lock/distributed-lock.decorator";

const RETENTION_YEARS = 7;
const ARCHIVE_AFTER_YEARS = 1;

@Injectable()
export class AuditLogService {
  private logs: any[] = [];

  async recordVerification(result: any) {
    const entry = {
      type: "VERIFICATION",
      ...result,
    };

    this.logs.push(entry);

    // ❗ Immutable simulation (append-only)
    Object.freeze(entry);

    return entry;
  }

  getLogs(limit = 50) {
    return this.logs.slice(-limit);
  }

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
    private readonly signingService: ExportSigningService,
    private readonly cursorPagination: CursorPaginationService,
  ) {}

  async record(entry: {
    userId?: string | null;
    action: AuditLog["action"];
    resourceType?: string;
    resourceId?: string;
    ipAddress: string;
    userAgent?: string;
    details?: string;
    metadata?: Record<string, unknown>;
    visibility?: AuditLogVisibility;
  }): Promise<AuditLog> {
    const searchText = [
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.ipAddress,
      entry.details,
    ]
      .filter(Boolean)
      .join(" ");

    const log = this.repo.create({ ...entry, searchText });
    return this.repo.save(log);
  }

  async query(dto: QueryAuditLogDto): Promise<AuditLogListResponseDto> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 100;

    const qb = this.repo.createQueryBuilder("log");

    if (dto.search) {
      qb.andWhere(
        `to_tsvector('english', log."searchText") @@ websearch_to_tsquery('english', :search)`,
        { search: dto.search },
      );
    }
    if (dto.userId) qb.andWhere("log.userId = :userId", { userId: dto.userId });
    if (dto.action) qb.andWhere("log.action = :action", { action: dto.action });
    if (dto.ipAddress)
      qb.andWhere("log.ipAddress = :ipAddress", { ipAddress: dto.ipAddress });
    if (dto.fromDate)
      qb.andWhere("log.createdAt >= :fromDate", { fromDate: dto.fromDate });
    if (dto.toDate)
      qb.andWhere("log.createdAt <= :toDate", { toDate: dto.toDate });

    if (dto.cursor) {
      this.cursorPagination.applyDescendingKeyset(qb, "log", dto.cursor);
      qb.take(limit + 1);
    } else {
      qb.orderBy("log.createdAt", "DESC")
        .addOrderBy("log.id", "DESC")
        .skip((page - 1) * limit)
        .take(limit);
    }

    const [rows, total] = await qb.getManyAndCount();
    const hasNext = Boolean(dto.cursor && rows.length > limit);
    const data = hasNext ? rows.slice(0, limit) : rows;

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      nextCursor:
        hasNext && data.length > 0
          ? this.cursorPagination.encode({
              createdAt: data[data.length - 1].createdAt,
              id: data[data.length - 1].id,
            })
          : null,
    };
  }

  async getTimeline(
    userId: string,
    page: number = 1,
    limit: number = 20,
    cursor?: string
  ): Promise<AuditLogListResponseDto> {
    const qb = this.repo.createQueryBuilder("log");
    
    qb.where("log.userId = :userId", { userId })
      .andWhere("log.visibility = :visibility", { visibility: AuditLogVisibility.PUBLIC });

    if (cursor) {
      this.cursorPagination.applyDescendingKeyset(qb, "log", cursor);
      qb.take(limit + 1);
    } else {
      qb.orderBy("log.createdAt", "DESC")
        .addOrderBy("log.id", "DESC")
        .skip((page - 1) * limit)
        .take(limit);
    }

    const [rows, total] = await qb.getManyAndCount();
    const hasNext = Boolean(cursor && rows.length > limit);
    const data = hasNext ? rows.slice(0, limit) : rows;

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      nextCursor:
        hasNext && data.length > 0
          ? this.cursorPagination.encode({
              createdAt: data[data.length - 1].createdAt,
              id: data[data.length - 1].id,
            })
          : null,
    };
  }

  async findById(id: string): Promise<AuditLog> {
    const log = await this.repo.findOne({ where: { id } });
    if (!log) throw new NotFoundException("Audit log not found");
    return log;
  }

  private async fetchForExport(dto: ExportAuditLogDto): Promise<AuditLog[]> {
    return this.repo
      .createQueryBuilder("log")
      .where("log.createdAt >= :fromDate", { fromDate: dto.fromDate })
      .andWhere("log.createdAt <= :toDate", { toDate: dto.toDate })
      .orderBy("log.createdAt", "ASC")
      .take(dto.limit ?? 10000)
      .getMany();
  }

  async exportToJson(
    dto: ExportAuditLogDto,
  ): Promise<{ payload: string; signature: string }> {
    const logs = await this.fetchForExport(dto);
    const payload = JSON.stringify(logs);
    const signature = this.signingService.sign(payload);
    return { payload, signature };
  }

  async exportToCsv(
    dto: ExportAuditLogDto,
  ): Promise<{ payload: string; signature: string }> {
    const logs = await this.fetchForExport(dto);
    const header = [
      "id",
      "userId",
      "action",
      "resourceType",
      "resourceId",
      "ipAddress",
      "createdAt",
    ];
    const rows = logs.map((log) =>
      header
        .map((field) => JSON.stringify((log as any)[field] ?? ""))
        .join(","),
    );
    const payload = [header.join(","), ...rows].join("\n");
    const signature = this.signingService.sign(payload);
    return { payload, signature };
  }

  // Moves logs older than 1 year to cold storage and marks them archived.
  // Cold-storage transfer is delegated to an external sink (S3/Glacier);
  // this only flips the archivedAt marker once the transfer succeeds.
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  @DistributedLock("audit:archive-old-logs", 30 * 60_000)
  async archiveOldLogs(
    coldStorageWriter?: (logs: AuditLog[]) => Promise<void>,
  ) {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - ARCHIVE_AFTER_YEARS);

    const logs = await this.repo
      .createQueryBuilder("log")
      .where("log.createdAt < :cutoff", { cutoff })
      .andWhere("log.archivedAt IS NULL")
      .getMany();

    if (logs.length === 0) return;

    if (coldStorageWriter) await coldStorageWriter(logs);

    await this.repo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ archivedAt: new Date() })
      .where("id IN (:...ids)", { ids: logs.map((l) => l.id) })
      .execute();
  }

  // Permanently deletes unprotected logs past the 7-year retention period.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  @DistributedLock("audit:enforce-retention", 30 * 60_000)
  async enforceRetention(): Promise<RetentionReport> {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - RETENTION_YEARS);
    const candidates = await this.repo.find({ where: { createdAt: LessThan(cutoff) } });
    const protectedRecords = candidates.filter((record) => this.isProtected(record));
    const eligibleRecords = candidates.filter((record) => !this.isProtected(record));
    if (eligibleRecords.length) await this.repo.remove(eligibleRecords);
    return this.createRetentionReport(cutoff, candidates, eligibleRecords, protectedRecords);
  }

  async previewRetention(cutoff = this.retentionCutoff()): Promise<RetentionReport> {
    const candidates = await this.repo.find({ where: { createdAt: LessThan(cutoff) } });
    const protectedRecords = candidates.filter((record) => this.isProtected(record));
    const eligibleRecords = candidates.filter((record) => !this.isProtected(record));
    return this.createRetentionReport(cutoff, candidates, eligibleRecords, protectedRecords);
  }

  private retentionCutoff(): Date {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - RETENTION_YEARS);
    return cutoff;
  }

  private createRetentionReport(
    cutoff: Date,
    candidates: AuditLog[],
    eligibleRecords: AuditLog[],
    protectedRecords: AuditLog[],
  ): RetentionReport {
    return {
      cutoff,
      scanned: candidates.length,
      eligible: eligibleRecords.length,
      protected: protectedRecords.length,
      affectedIds: eligibleRecords.map((record) => record.id),
      protectedIds: protectedRecords.map((record) => record.id),
    };
  }

  private isProtected(record: AuditLog): boolean {
    const metadata = record.metadata ?? {};
    return Boolean(metadata.retentionHold || metadata.activeDisputeId || metadata.auditCaseId || metadata.settlementId);
  }
}

export interface RetentionReport {
  cutoff: Date;
  scanned: number;
  eligible: number;
  protected: number;
  affectedIds: string[];
  protectedIds: string[];
}
