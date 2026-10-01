# Migration Safety Framework Guide

This document details the migration safety framework for the Trellis API. It establishes guardrails for schema and data migrations, ensuring contributors and operators can preview migration impact via dry-runs, validate data consistency with post-checks, and recover safely via documented rollback procedures.

---

## Architecture Overview

The Migration Safety Framework (`src/common/migrations/migration-safety.ts`) provides three defensive mechanisms:
1. **Pre-Migration Dry-Run Analysis**: Estimates affected rows, flags destructive and irreversible operations, and validates assumptions before altering production data.
2. **Post-Migration Consistency Validation**: Runs automated post-checks verifying foreign key constraints, zero-orphan rules, and expected column populations.
3. **Structured Rollback & Forward-Fix Runbooks**: Automatically generates SQL `down` commands and contingency guidance.

---

## 1. Dry-Run Impact Simulation

Before executing a migration, run dry-run simulation:

```ts
import { MigrationSafetyRunner, MigrationPlan } from '@/common/migrations/migration-safety';

const plan: MigrationPlan = {
  migrationName: '1787313600000-create-module-registry',
  version: '1.0.0',
  description: 'Create module registry and tenant states',
  steps: [
    {
      name: 'create_modules',
      table: 'modules',
      operation: 'CREATE_TABLE',
      isDestructive: false,
      reversible: true,
      sqlUp: 'CREATE TABLE ...',
      sqlDown: 'DROP TABLE "modules";',
    },
  ],
};

const report = await MigrationSafetyRunner.dryRun(plan, queryRunner);
console.log(report);
```

### Dry-Run Report Fields:
- `safeToProceed`: Boolean indicating if destructive or irreversible risks are acceptable.
- `destructiveSteps`: Count of operations dropping tables, columns, or truncating data.
- `irreversibleSteps`: Operations lacking an automated down migration.
- `estimatedAffectedRecords`: Pre-write row count inspection.
- `warnings`: Actionable warnings for high-risk changes.
- `rollbackNotes`: Ordered SQL commands to revert changes.

---

## 2. Post-Migration Consistency Checks

Post-checks execute immediately following `queryRunner.up()` to verify data integrity:

```ts
const postChecks = [
  {
    name: 'tenant_module_states_fk_integrity',
    description: 'Ensure no orphaned tenant states exist',
    query: 'SELECT COUNT(*) as count FROM "tenant_module_states" WHERE "moduleId" NOT IN (SELECT "id" FROM "modules");',
    validate: (result) => parseInt(result[0].count, 10) === 0,
    errorMessage: 'Foreign key consistency violated: orphaned tenant module states detected.',
  },
];

const checkResult = await MigrationSafetyRunner.executePostChecks(postChecks, queryRunner);
if (!checkResult.allPassed) {
  console.error('Post-migration checks failed:', checkResult.failures);
  // Trigger automated rollback or forward-fix runbook
}
```

---

## 3. Rollback & Recovery Procedures

### Scenario A: Reversible Schema Changes
Run TypeORM revert:
```bash
npm run migration:revert
```

### Scenario B: Data Migrations with Forward-Fix Required
When a data transformation cannot be cleanly reversed, follow the forward-fix procedure:
1. Halt background worker queues: `docker-compose stop worker`.
2. Inspect discrepancy logs produced by post-check failures.
3. Apply targeted remediation script from `src/migrations/fixes/`.
4. Re-run post-checks until `allPassed: true`.
5. Resume workers and monitor partial-failure metrics.
