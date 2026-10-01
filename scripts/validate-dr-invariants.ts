/**
 * Disaster Recovery Domain Invariants Validation CLI
 *
 * Runs strictly read-only checks across all core domain tables to verify
 * relationship consistency, absence of orphans, valid cryptographic/settlement references,
 * and data integrity after database restore or migration.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/validate-dr-invariants.ts
 *   npm run dr:validate
 *   npm run dr:validate -- --json
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DisasterRecoveryValidatorService } from '../src/infrastructure/disaster-recovery/disaster-recovery-validator.service';
import { InvariantSeverity } from '../src/infrastructure/disaster-recovery/disaster-recovery.types';

async function runDisasterRecoveryValidation() {
  const isJson = process.argv.includes('--json');

  if (!isJson) {
    console.log('================================================================');
    console.log(' 🛡️  TRELLIS API — DISASTER RECOVERY DOMAIN INVARIANT VALIDATION');
    console.log('================================================================');
    console.log('Mode: READ-ONLY VALIDATION\n');
  }

  // Create Nest app context silently
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const validator = app.get(DisasterRecoveryValidatorService);
    const report = await validator.validateAllInvariants();

    if (isJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Execution Time: ${report.executionTimeMs}ms`);
      console.log(`Total Checks:   ${report.totalChecks}`);
      console.log(`Passed Checks:  ${report.passedChecks}`);
      console.log(`Failed Checks:  ${report.failedChecks} (Critical: ${report.criticalFailures}, Errors: ${report.errorFailures}, Warnings: ${report.warningFailures})\n`);

      console.log('----------------------------------------------------------------');
      console.log(
        'STATUS | SEVERITY | CODE                           | VIOLATIONS | NAME',
      );
      console.log('----------------------------------------------------------------');

      for (const res of report.results) {
        const statusBadge = res.passed ? '✅ PASS' : '❌ FAIL';
        const severityBadge = res.severity.padEnd(8);
        const codeCol = res.code.padEnd(30);
        const countCol = String(res.violationCount).padStart(10);
        console.log(
          `${statusBadge} | ${severityBadge} | ${codeCol} | ${countCol} | ${res.name}`,
        );

        if (!res.passed && res.violations && res.violations.length > 0) {
          console.log(`       ↳ Description: ${res.description}`);
          console.log(`       ↳ Remediation: ${res.remediation}`);
          console.log(
            `       ↳ Sample Violations (first ${res.violations.length}):`,
          );
          for (const v of res.violations) {
            console.log(`         • ${v.description}`);
          }
          console.log('----------------------------------------------------------------');
        }
      }

      console.log('\n================================================================');
      if (report.isConsistent) {
        console.log('🎉 OVERALL STATUS: ALL CORE DOMAIN INVARIANTS CONSISTENT');
      } else {
        console.log('⚠️  OVERALL STATUS: INVARIANTS VIOLATED — ACTION REQUIRED');
      }
      console.log('================================================================\n');
    }

    await app.close();
    process.exit(report.isConsistent ? 0 : 1);
  } catch (err: any) {
    if (isJson) {
      console.error(JSON.stringify({ error: err.message, stack: err.stack }));
    } else {
      console.error('❌ Disaster recovery validation encountered a fatal error:', err);
    }
    await app.close();
    process.exit(1);
  }
}

runDisasterRecoveryValidation();
