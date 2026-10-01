import { Injectable, Logger, NotFoundException, ForbiddenException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { DataExport, ExportStatus } from "./entities/data-export.entity";
import { CreateExportDto, ExportScope } from "./dto/export.dto";

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly DEFAULT_RETENTION_DAYS = 7;
  private readonly MAX_RETENTION_DAYS = 90;

  constructor(
    @InjectRepository(DataExport)
    private readonly exportRepo: Repository<DataExport>,
  ) {}

  async createExport(userId: string, dto: CreateExportDto): Promise<DataExport> {
    const retentionDays = Math.min(dto.retentionDays || this.DEFAULT_RETENTION_DAYS, this.MAX_RETENTION_DAYS);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + retentionDays);

    const exportRecord = this.exportRepo.create({
      userId,
      scope: dto.scope,
      format: dto.format || "json",
      schemaVersion: dto.schemaVersion || "1.0.0",
      filters: dto.filters || {},
      status: ExportStatus.PENDING,
      expiresAt,
    });

    const saved = await this.exportRepo.save(exportRecord);
    this.logger.log(`Created export ${saved.id} for user ${userId}, scope: ${dto.scope}`);

    // In a real implementation, this would be enqueued as a background job
    // For now, we simulate processing
    setTimeout(() => this.processExport(saved.id), 1000);

    return saved;
  }

  async getExport(userId: string, exportId: string): Promise<DataExport> {
    const exportRecord = await this.exportRepo.findOne({ where: { id: exportId } });
    if (!exportRecord) {
      throw new NotFoundException("Export not found");
    }
    if (exportRecord.userId !== userId) {
      throw new ForbiddenException("You do not have access to this export");
    }
    return exportRecord;
  }

  async listExports(userId: string, limit = 50): Promise<DataExport[]> {
    return this.exportRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: limit,
    });
  }

  async processExport(exportId: string): Promise<void> {
    const exportRecord = await this.exportRepo.findOne({ where: { id: exportId } });
    if (!exportRecord) return;

    try {
      exportRecord.status = ExportStatus.PROCESSING;
      await this.exportRepo.save(exportRecord);

      const data = await this.extractData(exportRecord);
      const sanitized = this.applyPrivacyFilters(data, exportRecord.scope);
      const content = this.serialize(sanitized, exportRecord.format);

      exportRecord.status = ExportStatus.COMPLETED;
      exportRecord.downloadUrl = `data:application/${exportRecord.format};base64,${Buffer.from(content).toString("base64")}`;
      exportRecord.completedAt = new Date();
      await this.exportRepo.save(exportRecord);

      this.logger.log(`Export ${exportId} completed successfully`);
    } catch (error) {
      exportRecord.status = ExportStatus.FAILED;
      exportRecord.error = error.message;
      await this.exportRepo.save(exportRecord);
      this.logger.error(`Export ${exportId} failed: ${error.message}`);
    }
  }

  async expireOldExports(): Promise<number> {
    const result = await this.exportRepo
      .createQueryBuilder()
      .delete()
      .from(DataExport)
      .where("expiresAt < :now", { now: new Date() })
      .execute();

    const count = result.affected || 0;
    if (count > 0) {
      this.logger.log(`Expired ${count} old exports`);
    }
    return count;
  }

  private async extractData(exportRecord: DataExport): Promise<any[]> {
    // Privacy-safe extraction based on scope
    switch (exportRecord.scope) {
      case ExportScope.USER_DATA:
        return this.extractUserData(exportRecord);
      case ExportScope.PORTFOLIO:
        return this.extractPortfolioData(exportRecord);
      case ExportScope.AUDIT_LOG:
        return this.extractAuditData(exportRecord);
      case ExportScope.TRANSACTION_HISTORY:
        return this.extractTransactionData(exportRecord);
      default:
        return [];
    }
  }

  private async extractUserData(exportRecord: DataExport): Promise<any[]> {
    // User data: include only non-sensitive fields
    return [
      {
        schemaVersion: exportRecord.schemaVersion,
        exportedAt: new Date().toISOString(),
        data: {
          profile: { /* sanitized profile */ },
          preferences: { /* sanitized preferences */ },
        },
      },
    ];
  }

  private async extractPortfolioData(exportRecord: DataExport): Promise<any[]> {
    return [
      {
        schemaVersion: exportRecord.schemaVersion,
        exportedAt: new Date().toISOString(),
        portfolios: [], // Would query portfolio repository
      },
    ];
  }

  private async extractAuditData(exportRecord: DataExport): Promise<any[]> {
    return [
      {
        schemaVersion: exportRecord.schemaVersion,
        exportedAt: new Date().toISOString(),
        auditLog: [], // Would query audit repository
      },
    ];
  }

  private async extractTransactionData(exportRecord: DataExport): Promise<any[]> {
    return [
      {
        schemaVersion: exportRecord.schemaVersion,
        exportedAt: new Date().toISOString(),
        transactions: [], // Would query transaction repository
      },
    ];
  }

  private applyPrivacyFilters(data: any, scope: string): any {
    // Remove sensitive fields that should never be exported
    const sensitiveFields = ["password", "secret", "privateKey", "mnemonic", "apiKey"];

    const sanitize = (obj: any): any => {
      if (Array.isArray(obj)) {
        return obj.map(sanitize);
      }
      if (obj !== null && typeof obj === "object") {
        const sanitized: any = {};
        for (const [key, value] of Object.entries(obj)) {
          if (!sensitiveFields.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
            sanitized[key] = sanitize(value);
          }
        }
        return sanitized;
      }
      return obj;
    };

    return sanitize(data);
  }

  private serialize(data: any, format: string): string {
    switch (format) {
      case "json":
        return JSON.stringify(data, null, 2);
      case "csv":
        return this.convertToCsv(data);
      default:
        return JSON.stringify(data);
    }
  }

  private convertToCsv(data: any): string {
    // Simple CSV conversion for flat arrays
    if (!Array.isArray(data) || data.length === 0) return "";
    const headers = Object.keys(data[0]);
    const rows = data.map((item) => headers.map((h) => JSON.stringify(item[h] ?? "")).join(","));
    return [headers.join(","), ...rows].join("\n");
  }
}
