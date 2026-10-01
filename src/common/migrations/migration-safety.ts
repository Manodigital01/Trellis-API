/**
 * Migration Safety Framework for Trellis API (Issue #51)
 *
 * Provides dry-run impact simulation, pre-write record inspection, post-migration
 * consistency validation checks, and structured rollback/forward-fix runbooks.
 */

export interface MigrationStep {
  name: string;
  table: string;
  operation: "CREATE_TABLE" | "ALTER_TABLE" | "DROP_TABLE" | "CREATE_INDEX" | "DATA_TRANSFORMATION";
  estimatedAffectedRecords?: number;
  isDestructive: boolean;
  reversible: boolean;
  sqlUp: string;
  sqlDown: string;
}

export interface MigrationPlan {
  migrationName: string;
  version: string;
  description: string;
  steps: MigrationStep[];
  preChecks?: Array<() => Promise<boolean>>;
  postChecks?: Array<PostMigrationCheck>;
}

export interface PostMigrationCheck {
  name: string;
  description: string;
  query: string;
  validate: (result: any) => boolean;
  errorMessage: string;
}

export interface DryRunReport {
  migrationName: string;
  dryRunTimestamp: Date;
  safeToProceed: boolean;
  totalSteps: number;
  destructiveSteps: number;
  irreversibleSteps: number;
  estimatedAffectedRecords: number;
  warnings: string[];
  plannedOperations: Array<{
    step: string;
    table: string;
    operation: string;
    recordsAffected: number;
    reversible: boolean;
  }>;
  rollbackNotes: string[];
}

export interface PostCheckResult {
  allPassed: boolean;
  passedCount: number;
  failedCount: number;
  failures: Array<{
    checkName: string;
    description: string;
    error: string;
  }>;
}

export interface MockQueryRunner {
  query: (sql: string) => Promise<any>;
}

export class MigrationSafetyRunner {
  /**
   * Performs dry-run analysis for a migration plan.
   * Reports affected records, destructive operations, and generates rollback guidance.
   */
  public static async dryRun(
    plan: MigrationPlan,
    queryRunner?: MockQueryRunner,
  ): Promise<DryRunReport> {
    const warnings: string[] = [];
    const plannedOperations: DryRunReport["plannedOperations"] = [];
    const rollbackNotes: string[] = [];

    let destructiveCount = 0;
    let irreversibleCount = 0;
    let totalAffectedRecords = 0;

    for (const step of plan.steps) {
      let records = step.estimatedAffectedRecords ?? 0;

      // When query runner is provided, inspect live table row count before writes
      if (queryRunner && step.table) {
        try {
          const res = await queryRunner.query(
            `SELECT COUNT(*) AS count FROM "${step.table}"`,
          );
          if (res && res[0]?.count !== undefined) {
            records = parseInt(res[0].count, 10);
          }
        } catch (_) {
          // Table may not exist yet for CREATE_TABLE
        }
      }

      if (step.isDestructive) {
        destructiveCount++;
        warnings.push(
          `[CRITICAL] Destructive operation '${step.operation}' on table '${step.table}' (${records} existing records potentially affected).`,
        );
      }

      if (!step.reversible) {
        irreversibleCount++;
        warnings.push(
          `[WARNING] Irreversible operation '${step.operation}' in step '${step.name}'. Down migration cannot restore dropped data automatically.`,
        );
      }

      if (step.sqlDown) {
        rollbackNotes.push(`Step '${step.name}': Revert with -> ${step.sqlDown.trim()}`);
      } else {
        rollbackNotes.push(
          `Step '${step.name}': [MANUAL FORWARD-FIX REQUIRED] No automated SQL down defined.`,
        );
      }

      totalAffectedRecords += records;

      plannedOperations.push({
        step: step.name,
        table: step.table,
        operation: step.operation,
        recordsAffected: records,
        reversible: step.reversible,
      });
    }

    const safeToProceed = irreversibleCount === 0 || destructiveCount === 0;

    return {
      migrationName: plan.migrationName,
      dryRunTimestamp: new Date(),
      safeToProceed,
      totalSteps: plan.steps.length,
      destructiveSteps: destructiveCount,
      irreversibleSteps: irreversibleCount,
      estimatedAffectedRecords: totalAffectedRecords,
      warnings,
      plannedOperations,
      rollbackNotes,
    };
  }

  /**
   * Executes post-migration consistency validation checks to verify integrity.
   */
  public static async executePostChecks(
    checks: PostMigrationCheck[],
    queryRunner: MockQueryRunner,
  ): Promise<PostCheckResult> {
    const failures: PostCheckResult["failures"] = [];
    let passedCount = 0;

    for (const check of checks) {
      try {
        const result = await queryRunner.query(check.query);
        const passed = check.validate(result);

        if (passed) {
          passedCount++;
        } else {
          failures.push({
            checkName: check.name,
            description: check.description,
            error: check.errorMessage,
          });
        }
      } catch (err: any) {
        failures.push({
          checkName: check.name,
          description: check.description,
          error: `Post-check execution query threw an error: ${err.message}`,
        });
      }
    }

    return {
      allPassed: failures.length === 0,
      passedCount,
      failedCount: failures.length,
      failures,
    };
  }
}
