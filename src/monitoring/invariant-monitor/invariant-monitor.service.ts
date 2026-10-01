import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { v4 as uuidv4 } from "uuid";
import {
  InvariantCategory,
  InvariantCheckOutput,
  InvariantDefinition,
  InvariantReport,
  InvariantResult,
  InvariantSeverity,
  InvariantStatus,
} from "./invariant.types";
import { InvariantReportEntity } from "./entities/invariant-report.entity";
import { User } from "src/core/user/entities/user.entity";
import { Wallet } from "src/core/auth/entities/wallet.entity";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";
import { PortfolioAsset } from "src/investment/portfolio/entities/portfolio-asset.entity";
import { Transaction } from "src/investment/portfolio/entities/transaction.entity";
import { hasConflictingRoles, Role } from "src/common/guard/roles.enum";

@Injectable()
export class InvariantMonitorService implements OnModuleInit {
  private readonly logger = new Logger(InvariantMonitorService.name);
  private readonly invariants: InvariantDefinition[] = [];

  constructor(
    @InjectRepository(InvariantReportEntity)
    private readonly reportRepo: Repository<InvariantReportEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Portfolio)
    private readonly portfolioRepo: Repository<Portfolio>,
    @InjectRepository(PortfolioAsset)
    private readonly assetRepo: Repository<PortfolioAsset>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
  ) {}

  onModuleInit() {
    this.registerInvariants();
    this.logger.log(`Registered ${this.invariants.length} invariant checks`);
  }

  private registerInvariants() {
    // FUNDS
    this.invariants.push({
      id: "funds.portfolio_asset_non_negative",
      name: "Portfolio asset quantities non-negative",
      description: "All portfolio asset quantities must be >= 0",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Investigate transactions that caused negative balances. Reconcile affected portfolios manually.",
      check: async (): Promise<InvariantCheckOutput> => {
        const negativeAssets = await this.assetRepo
          .createQueryBuilder("asset")
          .where("asset.quantity < 0")
          .getMany();
        return {
          passed: negativeAssets.length === 0,
          message:
            negativeAssets.length === 0
              ? "All portfolio asset quantities are non-negative"
              : `Found ${negativeAssets.length} assets with negative quantities`,
          affectedRecordIds: negativeAssets.map((a) => a.id),
        };
      },
    });

    this.invariants.push({
      id: "funds.no_orphan_transactions",
      name: "No orphan transactions",
      description: "Every transaction references a valid portfolio",
      category: InvariantCategory.FUNDS,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Identify orphan transactions and link them to correct portfolios or archive them.",
      check: async (): Promise<InvariantCheckOutput> => {
        const orphans = await this.transactionRepo
          .createQueryBuilder("tx")
          .leftJoin(Portfolio, "p", "p.id = tx.portfolioId")
          .where("p.id IS NULL")
          .getMany();
        return {
          passed: orphans.length === 0,
          message:
            orphans.length === 0
              ? "All transactions reference valid portfolios"
              : `Found ${orphans.length} orphan transactions`,
          affectedRecordIds: orphans.map((t) => t.id),
        };
      },
    });

    // OWNERSHIP
    this.invariants.push({
      id: "ownership.portfolio_has_owner",
      name: "Every portfolio has an owner",
      description: "Every portfolio must reference an existing user",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Assign orphan portfolios to valid users or flag for manual review.",
      check: async (): Promise<InvariantCheckOutput> => {
        const orphans = await this.portfolioRepo
          .createQueryBuilder("p")
          .leftJoin(User, "u", "u.id = p.userId")
          .where("u.id IS NULL")
          .getMany();
        return {
          passed: orphans.length === 0,
          message:
            orphans.length === 0
              ? "All portfolios have valid owners"
              : `Found ${orphans.length} portfolios without valid owners`,
          affectedRecordIds: orphans.map((p) => p.id),
        };
      },
    });

    this.invariants.push({
      id: "ownership.wallet_has_user",
      name: "Every wallet has a user",
      description: "Every wallet must reference an existing user",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Investigate orphan wallets and link to correct users or remove.",
      check: async (): Promise<InvariantCheckOutput> => {
        const orphans = await this.walletRepo
          .createQueryBuilder("w")
          .leftJoin(User, "u", "u.id = w.userId")
          .where("u.id IS NULL")
          .getMany();
        return {
          passed: orphans.length === 0,
          message:
            orphans.length === 0
              ? "All wallets reference valid users"
              : `Found ${orphans.length} orphan wallets`,
          affectedRecordIds: orphans.map((w) => w.id),
        };
      },
    });

    this.invariants.push({
      id: "ownership.no_duplicate_wallet",
      name: "No duplicate wallet addresses across users",
      description: "No two users should share the same wallet address",
      category: InvariantCategory.OWNERSHIP,
      severity: InvariantSeverity.CRITICAL,
      remediation:
        "Investigate duplicate wallet addresses. Determine rightful owner and remove duplicates.",
      check: async (): Promise<InvariantCheckOutput> => {
        const duplicates = await this.userRepo
          .createQueryBuilder("u")
          .select("u.walletAddress")
          .addSelect("COUNT(*)", "cnt")
          .groupBy("u.walletAddress")
          .having("COUNT(*) > 1")
          .getRawMany();
        return {
          passed: duplicates.length === 0,
          message:
            duplicates.length === 0
              ? "No duplicate wallet addresses found"
              : `Found ${duplicates.length} duplicate wallet addresses`,
          affectedRecordIds: duplicates.map(
            (d) => d.u_walletAddress ?? d.walletAddress,
          ),
        };
      },
    });

    // LIFECYCLE
    this.invariants.push({
      id: "lifecycle.no_future_dates",
      name: "No future creation dates",
      description: "No createdAt dates should be in the future",
      category: InvariantCategory.LIFECYCLE,
      severity: InvariantSeverity.MEDIUM,
      remediation:
        "Correct records with future timestamps. Check for clock skew issues.",
      check: async (): Promise<InvariantCheckOutput> => {
        const futureUsers = await this.userRepo
          .createQueryBuilder("u")
          .where("u.createdAt > NOW()")
          .getMany();
        return {
          passed: futureUsers.length === 0,
          message:
            futureUsers.length === 0
              ? "No future creation dates found"
              : `Found ${futureUsers.length} users with future createdAt`,
          affectedRecordIds: futureUsers.map((u) => u.id),
        };
      },
    });

    this.invariants.push({
      id: "lifecycle.active_user_has_wallet",
      name: "Active users have wallet addresses",
      description: "Active users must have a wallet address set",
      category: InvariantCategory.LIFECYCLE,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Deactivate users without wallet addresses or prompt them to link a wallet.",
      check: async (): Promise<InvariantCheckOutput> => {
        const noWallet = await this.userRepo
          .createQueryBuilder("u")
          .where("u.isActive = true")
          .andWhere(
            "(u.walletAddress IS NULL OR u.walletAddress = '')",
          )
          .getMany();
        return {
          passed: noWallet.length === 0,
          message:
            noWallet.length === 0
              ? "All active users have wallet addresses"
              : `Found ${noWallet.length} active users without wallet addresses`,
          affectedRecordIds: noWallet.map((u) => u.id),
        };
      },
    });

    // AUTHORIZATION
    this.invariants.push({
      id: "auth.admin_count_bounded",
      name: "Admin count is bounded",
      description: "The number of admin users should be reasonable (warn if > 10)",
      category: InvariantCategory.AUTHORIZATION,
      severity: InvariantSeverity.MEDIUM,
      remediation:
        "Review admin user list. Remove unnecessary admin privileges to reduce attack surface.",
      check: async (): Promise<InvariantCheckOutput> => {
        const adminCount = await this.userRepo.count({
          where: { role: Role.ADMIN },
        });
        const threshold = 10;
        return {
          passed: true,
          warning: adminCount > threshold,
          message:
            adminCount > threshold
              ? `Admin count (${adminCount}) exceeds threshold of ${threshold}`
              : `Admin count (${adminCount}) is within bounds`,
          affectedRecordIds: [],
          metadata: { adminCount, threshold },
        };
      },
    });

    this.invariants.push({
      id: "auth.inactive_admin_check",
      name: "No stale admin accounts",
      description:
        "Admin/Maintainer users that haven't logged in for 90+ days",
      category: InvariantCategory.AUTHORIZATION,
      severity: InvariantSeverity.HIGH,
      remediation:
        "Review and deactivate stale privileged accounts. Contact account holders to verify continued need.",
      check: async (): Promise<InvariantCheckOutput> => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);

        const staleAdmins = await this.userRepo
          .createQueryBuilder("u")
          .where("u.role IN (:...roles)", {
            roles: [Role.ADMIN, Role.MAINTAINER],
          })
          .andWhere(
            "(u.lastLoginAt IS NULL OR u.lastLoginAt < :cutoff)",
            { cutoff },
          )
          .getMany();
        return {
          passed: true,
          warning: staleAdmins.length > 0,
          message:
            staleAdmins.length === 0
              ? "No stale admin/maintainer accounts found"
              : `Found ${staleAdmins.length} admin/maintainer accounts inactive for 90+ days`,
          affectedRecordIds: staleAdmins.map((u) => u.id),
        };
      },
    });
  }

  async runAllChecks(triggeredBy = "system"): Promise<InvariantReport> {
    return this.runChecks(this.invariants, triggeredBy);
  }

  async runChecksByCategory(
    category: InvariantCategory,
    triggeredBy = "system",
  ): Promise<InvariantReport> {
    const filtered = this.invariants.filter((i) => i.category === category);
    return this.runChecks(filtered, triggeredBy, category);
  }

  async runSingleCheck(invariantId: string): Promise<InvariantResult> {
    const definition = this.invariants.find((i) => i.id === invariantId);
    if (!definition) {
      return {
        id: invariantId,
        name: "Unknown",
        category: InvariantCategory.FUNDS,
        severity: InvariantSeverity.LOW,
        status: InvariantStatus.ERROR,
        message: `Invariant '${invariantId}' not found`,
        affectedRecordIds: [],
        remediation: "Verify invariant ID is correct",
        checkedAt: new Date(),
        durationMs: 0,
      };
    }
    return this.executeCheck(definition);
  }

  async getReports(
    limit = 20,
  ): Promise<InvariantReportEntity[]> {
    return this.reportRepo.find({
      order: { generatedAt: "DESC" },
      take: limit,
    });
  }

  async getReport(id: string): Promise<InvariantReportEntity | null> {
    return this.reportRepo.findOne({ where: { id } });
  }

  getRegisteredInvariants(): Pick<
    InvariantDefinition,
    "id" | "name" | "category" | "severity" | "description"
  >[] {
    return this.invariants.map(({ id, name, category, severity, description }) => ({
      id,
      name,
      category,
      severity,
      description,
    }));
  }

  private async runChecks(
    definitions: InvariantDefinition[],
    triggeredBy: string,
    category?: InvariantCategory,
  ): Promise<InvariantReport> {
    const results: InvariantResult[] = [];

    for (const definition of definitions) {
      const result = await this.executeCheck(definition);
      results.push(result);
    }

    const passed = results.filter((r) => r.status === InvariantStatus.PASS).length;
    const failed = results.filter((r) => r.status === InvariantStatus.FAIL).length;
    const warnings = results.filter((r) => r.status === InvariantStatus.WARN).length;
    const errors = results.filter((r) => r.status === InvariantStatus.ERROR).length;

    const report: InvariantReport = {
      reportId: uuidv4(),
      generatedAt: new Date(),
      totalChecks: results.length,
      passed,
      failed,
      warnings,
      errors,
      results,
      summary: this.buildSummary(passed, failed, warnings, errors),
    };

    await this.reportRepo.save(
      this.reportRepo.create({
        id: report.reportId,
        generatedBy: triggeredBy,
        totalChecks: report.totalChecks,
        passed: report.passed,
        failed: report.failed,
        warnings: report.warnings,
        errors: report.errors,
        results: report.results,
        summary: report.summary,
        category: category ?? null,
      }),
    );

    this.logger.log(
      `Invariant report ${report.reportId}: ${passed} passed, ${failed} failed, ${warnings} warnings, ${errors} errors`,
    );

    return report;
  }

  private async executeCheck(
    definition: InvariantDefinition,
  ): Promise<InvariantResult> {
    const startTime = Date.now();
    try {
      const output = await definition.check();
      const durationMs = Date.now() - startTime;

      let status: InvariantStatus;
      if (!output.passed) {
        status = InvariantStatus.FAIL;
      } else if (output.warning) {
        status = InvariantStatus.WARN;
      } else {
        status = InvariantStatus.PASS;
      }

      return {
        id: definition.id,
        name: definition.name,
        category: definition.category,
        severity: definition.severity,
        status,
        message: output.message,
        affectedRecordIds: output.affectedRecordIds,
        remediation: definition.remediation,
        checkedAt: new Date(),
        durationMs,
        metadata: output.metadata,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logger.error(
        `Invariant check ${definition.id} failed with error: ${error}`,
      );
      return {
        id: definition.id,
        name: definition.name,
        category: definition.category,
        severity: definition.severity,
        status: InvariantStatus.ERROR,
        message: `Check failed: ${error instanceof Error ? error.message : String(error)}`,
        affectedRecordIds: [],
        remediation: definition.remediation,
        checkedAt: new Date(),
        durationMs,
      };
    }
  }

  private buildSummary(
    passed: number,
    failed: number,
    warnings: number,
    errors: number,
  ): string {
    const parts: string[] = [];
    if (failed > 0) parts.push(`${failed} FAILED`);
    if (warnings > 0) parts.push(`${warnings} warnings`);
    if (errors > 0) parts.push(`${errors} errors`);
    if (parts.length === 0) return `All ${passed} invariant checks passed.`;
    return `${passed} passed, ${parts.join(", ")}. Investigate failures immediately.`;
  }
}
