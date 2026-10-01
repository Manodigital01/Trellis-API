# Release Readiness Checklist

This document outlines the release readiness process for Trellis API. All **critical changes** must pass the release checklist before merge and deployment.

## Overview

The release readiness checklist ensures that changes meet production standards across five key areas:
- **Tests**: Unit, integration, and edge case coverage
- **Migrations**: Reversibility, locking behavior, and safe backfills
- **Configuration**: Environment validation and secrets management
- **Documentation**: API contracts, deployment steps, breaking changes
- **Rollback**: Procedure definition, data safety, and monitoring

## What Counts as Critical?

A change is critical if it touches:
- Schema or database migrations
- Authentication or authorization logic
- Payment, billing, or financial features
- Data export or privacy-sensitive features
- Core configuration or deployment procedures

Non-critical changes require only the subset of **CRITICAL** severity checks.

## Checklist Categories

### Tests (CRITICAL & HIGH)
- **Unit Test Coverage** (CRITICAL): ≥80% coverage for changed files; `npm run test:coverage` passes
- **Integration Tests** (HIGH): `npm run test:integration` passes; no flaky tests
- **Edge Case Tests** (HIGH): 2+ edge cases per feature; sad path testing

### Migrations (CRITICAL & HIGH)
- **Migration Reversibility** (CRITICAL): Every migration has a `down()` function; tested: up → down → up
- **No Long Locks** (HIGH): Avoid `LOCK TABLE` on large tables; use `CONCURRENTLY` for indexes
- **Safe Backfill** (HIGH): Tested with ≥100k rows; no timeouts or OOM

### Configuration (CRITICAL & MEDIUM)
- **Environment Validation** (HIGH): `.env.example` updated; ConfigService validates on boot
- **Secrets Not Committed** (CRITICAL): No secrets in code; `.env` in `.gitignore`; `npm audit` passes
- **Feature Flags** (MEDIUM): Risky features behind toggles; no redeployment to disable

### Documentation (HIGH & MEDIUM)
- **API Contract Updated** (HIGH): OpenAPI/GraphQL schema and docs match changes
- **Deployment Steps** (HIGH): Step-by-step instructions in docs or PR description
- **Breaking Changes** (HIGH): CHANGELOG.md updated; migration guide linked

### Rollback (CRITICAL & HIGH)
- **Rollback Procedure** (CRITICAL): Clear steps in docs/RUNBOOK.md; tested on staging
- **Data Safety** (CRITICAL): Backward compatible; new columns can be null
- **Rollback Monitoring** (HIGH): Error rate, latency, and consistency metrics monitored

### Performance (HIGH & MEDIUM)
- **No Regression** (HIGH): Benchmark tests pass; no O(n²) algorithms; queries indexed
- **Scaling** (MEDIUM): Known limits documented (max rows, rate limits, job queue behavior)

## Automatable Checks

The following checks can be run automatically in CI:

```bash
# Unit test coverage
npm run test:coverage

# Integration tests
npm run test:integration

# Secrets audit
npm audit

# Performance benchmarks
npm run bench
```

## Manual Checks

The following checks require human review:

- Migration reversibility (test locally)
- Edge case test coverage
- Locking behavior review
- Breaking change documentation
- Rollback procedure validation

## Waiving Checks

A check may be waived with **maintainer approval** if:

1. The check is non-critical (MEDIUM or LOW severity)
2. The reason is documented
3. An approver explicitly signs off

Waive with:
```
PATCH /api/v1/admin/release-checklist/{prNumber}/waive/{checkId}
{
  "reason": "This change does not require migrations in this deployment",
  "approvedBy": "maintainer@example.com"
}
```

## Approval Workflow

1. **Author** submits PR with all changes
2. **CI** runs automatable checks; results posted to PR
3. **Maintainer** reviews non-automatable checks
4. **Maintainer** marks checks as passed or waives with reason
5. **Maintainer** approves release when all critical checks pass:
   ```
   PATCH /api/v1/admin/release-checklist/{prNumber}/approve
   {
     "approvedBy": "maintainer@example.com"
   }
   ```
6. **Deployment gate** blocks deployment if checklist is not approved

## Checklist API

### Create Checklist

```http
POST /api/v1/admin/release-checklist
Content-Type: application/json

{
  "prNumber": "123",
  "title": "Add Redis Sentinel support",
  "files": ["src/common/cache/cache-redis.factory.ts"]
}

Response:
{
  "checklist": { ... },
  "summary": {
    "total": 12,
    "passed": 0,
    "failed": 0,
    "blocked": 0,
    "waived": 0,
    "notStarted": 12,
    "readinessPercent": 0,
    "overallStatus": "NEEDS_ATTENTION"
  }
}
```

### Update Check Result

```http
PATCH /api/v1/admin/release-checklist/{prNumber}/checks/{checkId}
Content-Type: application/json

{
  "status": "PASSED",
  "evidenceUrl": "https://github.com/.../runs/123456",
  "notes": "All tests passed locally and in CI"
}
```

### Get Checklist Status

```http
GET /api/v1/admin/release-checklist/{prNumber}

Response:
{
  "checklist": { ... },
  "summary": { ... },
  "markdown": "## Release Readiness Checklist\n..."
}
```

### Waive Check

```http
PATCH /api/v1/admin/release-checklist/{prNumber}/waive/{checkId}
Content-Type: application/json

{
  "reason": "Not applicable to this deployment phase",
  "approvedBy": "maintainer@example.com"
}
```

### Approve Release

```http
PATCH /api/v1/admin/release-checklist/{prNumber}/approve
Content-Type: application/json

{
  "approvedBy": "maintainer@example.com"
}

Response:
{
  "status": "success",
  "message": "Release approved",
  "canDeploy": true
}
```

## Exception Handling

### Emergency Fixes

If a critical production issue requires bypassing the checklist:

1. Document the severity and justification
2. Obtain approval from at least **2 maintainers**
3. Create a follow-up issue to audit the change
4. Post-merge, run deferred checks and waive with justification

### Partial Deployments

If deploying to staging first:

1. Checklist must pass before staging deployment
2. Staging observations may inform rollback plans
3. Same checklist requirement for production deployment

## Maintainer Sign-Off

Maintainer approval confirms:

- ✅ All critical checks passed or waived with justification
- ✅ Tests cover the intended behavior and edge cases
- ✅ Migrations are safe and reversible
- ✅ Rollback procedure is documented and tested
- ✅ No secrets or sensitive data in code
- ✅ Documentation is complete and accurate

## Examples

### Critical Change: Schema Migration

```yaml
PR: "Add user_preferences table and foreign key from users"
Files:
  - src/auth/entities/user-preference.entity.ts
  - db/migrations/20250127_create_user_preferences.ts

Checklist Status:
  - test_unit_coverage: PASSED (82%)
  - test_integration: PASSED
  - migration_reversibility: PASSED (tested up/down/up)
  - migration_locking: PASSED (CONCURRENTLY used)
  - docs_deployment: PASSED
  - rollback_procedure: PASSED
  - performance_no_regression: PASSED

Approval: ✅ READY for deployment
```

### Non-Critical: Documentation Update

```yaml
PR: "Update API documentation for portfolio endpoint"
Files:
  - docs/API.md

Checklist Status:
  - test_unit_coverage: NOT_APPLICABLE
  - docs_api_contracts: PASSED

Approval: ✅ READY to merge
```

## See Also

- [MIGRATION_SAFETY.md](./MIGRATION_SAFETY.md) — Detailed migration guidelines
- [OPERATIONAL_RUNBOOK.md](./OPERATIONAL_RUNBOOK.md) — Incident and rollback procedures
- [docs/DEPLOYMENT.md](./DEPLOYMENT.md) — Deployment playbook
