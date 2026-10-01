import { Injectable } from "@nestjs/common";
import { logger } from "../../config/logger";
import {
  ReleaseChecklist,
  ReleaseCheck,
  CheckResult,
  CheckStatus,
  CheckSeverity,
  TRELLIS_API_RELEASE_CHECKS,
  isCriticalChange,
  calculateReleaseStatus,
} from "./release-checklist";

/**
 * Service for managing release readiness checklists.
 *
 * Provides:
 * - Checklist creation and initialization
 * - Check status updates
 * - Waiver management for exceptions
 * - Overall release readiness assessment
 * - Approval workflow
 */
@Injectable()
export class ReleaseChecklistService {
  /**
   * Create a new release checklist for a PR.
   */
  createChecklist(
    prNumber: string,
    title: string,
    files: string[],
  ): ReleaseChecklist {
    const isCritical = isCriticalChange(title, files);
    const checks = isCritical ? TRELLIS_API_RELEASE_CHECKS : this.getMinimalChecks();

    const checklist: ReleaseChecklist = {
      prNumber,
      title,
      isCriticalChange: isCritical,
      checks,
      results: new Map(),
      overallStatus: "NEEDS_ATTENTION",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Initialize all checks as NOT_STARTED
    for (const check of checks) {
      checklist.results.set(check.id, {
        checkId: check.id,
        status: CheckStatus.NOT_STARTED,
      });
    }

    logger.info(
      { prNumber, isCritical, checkCount: checks.length },
      "Release checklist created",
    );

    return checklist;
  }

  /**
   * Get the minimal checklist for non-critical changes.
   */
  private getMinimalChecks(): ReleaseCheck[] {
    return TRELLIS_API_RELEASE_CHECKS.filter(
      (c) => c.severity === CheckSeverity.CRITICAL,
    );
  }

  /**
   * Update a check result.
   */
  updateCheckResult(
    checklist: ReleaseChecklist,
    checkId: string,
    status: CheckStatus,
    options?: {
      failureReason?: string;
      evidenceUrl?: string;
      waiverReason?: string;
      waiverApprovedBy?: string;
      notes?: string;
    },
  ): void {
    const existingResult = checklist.results.get(checkId);
    if (!existingResult) {
      logger.warn({ checkId }, "Check not found in checklist");
      return;
    }

    const result: CheckResult = {
      checkId,
      status,
      passedAt: status === CheckStatus.PASSED ? new Date() : undefined,
      failureReason: options?.failureReason,
      evidenceUrl: options?.evidenceUrl,
      waiverReason: options?.waiverReason,
      waiverApprovedBy: options?.waiverApprovedBy,
      notes: options?.notes,
    };

    checklist.results.set(checkId, result);
    checklist.updatedAt = new Date();
    checklist.overallStatus = calculateReleaseStatus(checklist.results) as any;

    logger.info(
      { checkId, status, prNumber: checklist.prNumber },
      "Check result updated",
    );
  }

  /**
   * Waive a check with approval.
   */
  waiveCheck(
    checklist: ReleaseChecklist,
    checkId: string,
    reason: string,
    approvedBy: string,
  ): void {
    this.updateCheckResult(checklist, checkId, CheckStatus.WAIVED, {
      waiverReason: reason,
      waiverApprovedBy: approvedBy,
    });

    logger.warn(
      { checkId, approvedBy, prNumber: checklist.prNumber },
      "Check waived",
    );
  }

  /**
   * Mark a check as blocked pending external action.
   */
  blockCheck(
    checklist: ReleaseChecklist,
    checkId: string,
    reason: string,
  ): void {
    this.updateCheckResult(checklist, checkId, CheckStatus.BLOCKED, {
      failureReason: reason,
    });

    logger.warn(
      { checkId, reason, prNumber: checklist.prNumber },
      "Check blocked",
    );
  }

  /**
   * Get all checks that still need attention.
   */
  getPendingChecks(checklist: ReleaseChecklist): CheckResult[] {
    return Array.from(checklist.results.values()).filter(
      (r) =>
        r.status !== CheckStatus.PASSED &&
        r.status !== CheckStatus.WAIVED,
    );
  }

  /**
   * Get checklist readiness summary.
   */
  getReadinessSummary(checklist: ReleaseChecklist): {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    waived: number;
    notStarted: number;
    readinessPercent: number;
    overallStatus: "READY" | "NEEDS_ATTENTION" | "BLOCKED";
    blockingIssues: string[];
  } {
    const results = Array.from(checklist.results.values());
    const byStatus = {
      passed: results.filter((r) => r.status === CheckStatus.PASSED).length,
      failed: results.filter((r) => r.status === CheckStatus.FAILED).length,
      blocked: results.filter((r) => r.status === CheckStatus.BLOCKED).length,
      waived: results.filter((r) => r.status === CheckStatus.WAIVED).length,
      notStarted: results.filter((r) => r.status === CheckStatus.NOT_STARTED)
        .length,
    };

    const blockingIssues = results
      .filter((r) => r.status === CheckStatus.BLOCKED)
      .map(
        (r) =>
          `${r.checkId}: ${r.failureReason || "No reason provided"}`,
      );

    const completedCount = byStatus.passed + byStatus.waived;
    const readinessPercent = results.length > 0 ? (completedCount / results.length) * 100 : 0;

    return {
      total: results.length,
      passed: byStatus.passed,
      failed: byStatus.failed,
      blocked: byStatus.blocked,
      waived: byStatus.waived,
      notStarted: byStatus.notStarted,
      readinessPercent: Math.round(readinessPercent),
      overallStatus: checklist.overallStatus,
      blockingIssues,
    };
  }

  /**
   * Approve a release (mark as ready for deployment).
   */
  approveRelease(
    checklist: ReleaseChecklist,
    approvedBy: string,
  ): boolean {
    if (checklist.overallStatus === "BLOCKED") {
      logger.warn(
        { prNumber: checklist.prNumber },
        "Cannot approve: critical checks are blocked",
      );
      return false;
    }

    checklist.approvedBy = approvedBy;
    checklist.approvedAt = new Date();

    logger.info(
      { prNumber: checklist.prNumber, approvedBy },
      "Release approved",
    );

    return true;
  }

  /**
   * Validate that all critical checks are completed before approval.
   */
  canApproveRelease(checklist: ReleaseChecklist): {
    canApprove: boolean;
    reason?: string;
  } {
    if (checklist.overallStatus === "BLOCKED") {
      return {
        canApprove: false,
        reason: "Critical checks are still blocked",
      };
    }

    const criticalChecks = checklist.checks.filter(
      (c) => c.severity === CheckSeverity.CRITICAL,
    );

    for (const check of criticalChecks) {
      const result = checklist.results.get(check.id);
      if (!result || (result.status !== CheckStatus.PASSED && result.status !== CheckStatus.WAIVED)) {
        return {
          canApprove: false,
          reason: `Critical check not completed: ${check.name}`,
        };
      }
    }

    return { canApprove: true };
  }

  /**
   * Get automatable checks that haven't been run yet.
   */
  getAutomatableChecks(checklist: ReleaseChecklist): ReleaseCheck[] {
    return checklist.checks.filter(
      (c) =>
        c.automatable &&
        c.automationCommand &&
        checklist.results.get(c.id)?.status === CheckStatus.NOT_STARTED,
    );
  }

  /**
   * Format checklist for GitHub PR comment.
   */
  formatForPR(checklist: ReleaseChecklist): string {
    const summary = this.getReadinessSummary(checklist);
    const checks = Array.from(checklist.results.entries());

    const statusEmoji = {
      [CheckStatus.PASSED]: "✅",
      [CheckStatus.FAILED]: "❌",
      [CheckStatus.BLOCKED]: "🚫",
      [CheckStatus.WAIVED]: "⏭️",
      [CheckStatus.NOT_STARTED]: "⏳",
      [CheckStatus.IN_PROGRESS]: "🔄",
    };

    let markdown = `## Release Readiness Checklist\n\n`;
    markdown += `**Overall Status:** ${summary.overallStatus}\n`;
    markdown += `**Progress:** ${summary.passed}/${summary.total} checks passed (${summary.readinessPercent}%)\n\n`;

    // Group by category
    const byCategory = new Map<string, typeof checks>();
    for (const [checkId, result] of checks) {
      const check = checklist.checks.find((c) => c.id === checkId);
      if (check) {
        if (!byCategory.has(check.category)) {
          byCategory.set(check.category, []);
        }
        byCategory.get(check.category)!.push([checkId, result]);
      }
    }

    for (const [category, categoryChecks] of byCategory) {
      markdown += `### ${category.toUpperCase()}\n`;
      for (const [checkId, result] of categoryChecks) {
        const check = checklist.checks.find((c) => c.id === checkId);
        if (check) {
          markdown += `- ${statusEmoji[result.status]} **${check.name}** (${check.severity})\n`;
          if (result.failureReason) {
            markdown += `  - ❌ ${result.failureReason}\n`;
          }
          if (result.waiverReason) {
            markdown += `  - ⏭️ Waived: ${result.waiverReason} (by ${result.waiverApprovedBy})\n`;
          }
        }
      }
      markdown += "\n";
    }

    if (summary.blockingIssues.length > 0) {
      markdown += `### ⚠️ Blocking Issues\n`;
      for (const issue of summary.blockingIssues) {
        markdown += `- ${issue}\n`;
      }
      markdown += "\n";
    }

    markdown += `---\n`;
    markdown += `*Release checklist for #${checklist.prNumber}*\n`;

    return markdown;
  }
}
