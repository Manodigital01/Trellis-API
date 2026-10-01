# Infrastructure Improvements: Complete Guide

This document provides an integrated overview of four critical infrastructure improvements to the Trellis API: Redis high-availability, database diagnostics, semantic validation, and release readiness.

## Overview

These improvements address production reliability, data integrity, and deployment safety across the Trellis API backend.

### Issues Addressed
- **Issue #78**: Redis Sentinel & Cluster connection fallback for HA
- **Issue #81**: Automated index fragmentation check and unindexed FK detector
- **Issue #123**: Semantic validation layer for business-rule edge cases
- **Issue #128**: Release readiness checklist and automated gate for critical changes

---

## 1. Redis High-Availability (Issue #78)

### Configuration

Enable Sentinel mode via environment variables:

```bash
REDIS_SENTINEL_ENABLED=true
REDIS_SENTINEL_HOSTS='[{"host":"sentinel1","port":26379},{"host":"sentinel2","port":26379}]'
REDIS_SENTINEL_NAME=mymaster
REDIS_PASSWORD=your-redis-password
REDIS_SENTINEL_PASSWORD=your-sentinel-password
```

Or enable Cluster mode:

```bash
REDIS_CLUSTER_ENABLED=true
REDIS_CLUSTER_HOSTS='[{"host":"node1","port":6379},{"host":"node2","port":6379}]'
REDIS_PASSWORD=your-redis-password
```

### Features

- **Automatic Failover**: Sentinel automatically detects primary failure and promotes replica
- **Exponential Backoff**: Reconnection attempts with 200ms initial delay, capped at 5 seconds, max 10 attempts
- **Event Handling**: Logs all connection state changes for monitoring
- **Backward Compatible**: Standalone mode still works with `REDIS_URL` only

### Usage

```typescript
// CacheService automatically handles failover - no code changes needed
const value = await cacheService.get('user', userId);
await cacheService.set('user', userData, [userId]);
```

---

## 2. Database Index Diagnostics (Issue #81)

### Admin Endpoints

Run diagnostics via REST API:

```bash
# Full index health diagnostic
curl GET /api/v1/admin/database/index-health

# Fragmentation analysis only
curl GET /api/v1/admin/database/index-fragmentation

# Missing foreign key indexes
curl GET /api/v1/admin/database/missing-fk-indexes

# Optimization suggestions
curl POST /api/v1/admin/database/analyze-indexes
```

### CLI Commands

Run diagnostics from command line:

```bash
# Full health check with recommendations
npm run cli -- index-health-check

# Check index fragmentation levels
npm run cli -- check-fragmentation

# Detect unindexed foreign keys
npm run cli -- check-missing-fks

# Analyze slow queries
npm run cli -- analyze-slow-queries
```

### Alert Thresholds

Severity levels and recommended actions:

| Fragmentation | Severity | Action |
|---------------|----------|--------|
| < 30%         | LOW      | Monitor, no action needed |
| 30-50%        | MEDIUM   | Schedule REINDEX in maintenance window |
| > 50%         | HIGH     | REINDEX urgently to reclaim space |

### Production Usage

Safe to run in production - all queries are read-only and don't acquire locks:

```typescript
// ServiceExample: Scheduled diagnostics
@Injectable()
export class DatabaseHealthService {
  constructor(private indexService: DatabaseIndexService) {}
  
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async dailyDiagnostics() {
    const health = await this.indexService.runIndexHealthDiagnostic();
    if (health.summary.highSeverityFragmentation > 0) {
      // Alert ops team
    }
  }
}
```

---

## 3. Semantic Validation Layer (Issue #123)

### Business-Rule Validation

Beyond shape/schema validation, semantic validation enforces business rules:

```typescript
@Post('/portfolio/transfer')
async transfer(@Body() dto: TransferDto) {
  // Date range validation
  this.validator.validateDateRange(dto.startDate, dto.endDate);
  
  // Numeric bounds
  this.validator.validateMinimum(dto.amount, 0.01, 'amount');
  this.validator.validateMaximum(dto.amount, 1_000_000, 'amount');
  
  // Mutually exclusive fields
  this.validator.validateExclusive(dto, ['walletId', 'accountId']);
  
  // Conditional requirements
  this.validator.validateConditionalRequired(
    dto,
    'useStopLoss',
    ['stopLossPrice', 'stopLossPercentage']
  );
  
  // Process transfer...
}
```

### Stable Error Codes

All validation failures return consistent error codes for client handling:

```typescript
// Example error response
{
  "statusCode": 400,
  "message": "ERR_INVALID_DATE_RANGE",
  "errors": [{
    "code": "ERR_INVALID_DATE_RANGE",
    "field": "dateRange",
    "constraints": {
      "dateRangeViolation": "Start date must be before or equal to end date"
    },
    "context": {
      "startDate": "2026-10-01",
      "endDate": "2026-09-28"
    }
  }]
}
```

### Available Validators

| Method | Purpose | Example |
|--------|---------|---------|
| `validateDateRange()` | Start ≤ end | Rebalancing date window |
| `validateMinimum()` | Value ≥ min | Minimum portfolio allocation |
| `validateMaximum()` | Value ≤ max | Maximum position size |
| `validateNoDuplicates()` | Unique items | Asset allocation list |
| `validateBusinessPattern()` | Regex match | Wallet address format |
| `validateExclusive()` | One of N | Payment method selection |
| `validateAtLeastOne()` | At least one | Required trade conditions |
| `validateConditionalRequired()` | If A then B | Dependent parameters |

---

## 4. Release Readiness Checklist (Issue #128)

### Release Workflow

Before critical PRs merge:

1. **Create Checklist** (automated)
2. **Run Automatable Checks** (CI/CD)
3. **Complete Manual Checks** (team)
4. **Waive Exceptions** (with approval)
5. **Approve Release** (maintainer)

### REST API Workflow

```typescript
// Create checklist for PR
POST /api/v1/admin/release-checklist
{
  "prNumber": "195",
  "title": "Add new asset oracle",
  "files": ["src/blockchain/oracle/..."]
}

// Update check status
PATCH /api/v1/admin/release-checklist/195/checks/test_unit_coverage
{
  "status": "PASSED",
  "evidenceUrl": "https://ci.example.com/builds/12345"
}

// Waive a check with approval
PATCH /api/v1/admin/release-checklist/195/checks/test_integration
{
  "status": "WAIVED",
  "waiverReason": "Integration tests skipped - no DB schema changes",
  "waiverApprovedBy": "alice@example.com"
}

// Approve release
POST /api/v1/admin/release-checklist/195/approve
{
  "approvedBy": "maintainer@example.com"
}

// Get readiness summary
GET /api/v1/admin/release-checklist/195/summary
```

### Check Categories

#### Tests (3 checks)
- Unit Test Coverage (≥80%)
- Integration Tests
- Edge Case Tests (boundary + 2+ per feature)

#### Migrations (2 checks)
- Rollback Testing
- Data Consistency

#### Config (2 checks)
- Secrets Audit
- Feature Flag Documentation

#### Docs (3 checks)
- API Documentation
- Configuration Guide
- Migration Guide

#### Rollback (4 checks)
- Rollback Plan
- Feature Flag Disable
- Database Revert Capability
- Emergency Patch Path

#### Performance (2 checks)
- Benchmark Results
- Memory Impact

### GitHub PR Integration

Checklist auto-formats as GitHub PR comment:

```markdown
## Release Readiness Checklist

**Overall Status**: NEEDS_ATTENTION
**Progress**: 10/18 checks passed (56%)

### Tests
- ✅ **Unit Test Coverage** (CRITICAL)
- ⏳ **Integration Tests** (HIGH)
- ❌ **Edge Case Tests** (HIGH)

### Migrations
- ✅ **Rollback Testing** (CRITICAL)
- ⏳ **Data Consistency** (HIGH)

...
```

---

## Integration Example

Complete example showing all 4 features working together:

```typescript
@Injectable()
export class CriticalTransferService {
  constructor(
    private cacheService: CacheService,
    private indexService: DatabaseIndexService,
    private validator: SemanticValidatorService,
    private releaseService: ReleaseChecklistService,
  ) {}

  @Post('/portfolio/critical-transfer')
  async criticalTransfer(@Body() dto: CriticalTransferDto) {
    // 1. SEMANTIC VALIDATION (Issue #123)
    // Validate business rules before processing
    this.validator.validateDateRange(
      dto.executionDate,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    );
    this.validator.validateMinimum(dto.amount, 1000, 'amount');
    this.validator.validateExclusive(dto, ['walletId', 'accountId']);

    // 2. REDIS HA (Issue #78)
    // Cache validation state - automatically handles failover
    const cacheKey = `transfer:validation:${dto.id}`;
    await this.cacheService.set('transfer-validation', {
      userId: dto.userId,
      amount: dto.amount,
      validated: true,
    }, [dto.id]);

    // 3. DATABASE DIAGNOSTICS (Issue #81)
    // Check database health before critical operation
    const dbHealth = await this.indexService.runIndexHealthDiagnostic();
    if (dbHealth.summary.highSeverityFragmentation > 0) {
      // Log warning but proceed with critical transfer
      logger.warn('Database fragmentation detected during critical transfer');
    }

    // 4. RELEASE READINESS (Issue #128)
    // Log critical operation for release checklist
    const checklist = this.releaseService.createChecklist(
      'transfer-pr',
      'Critical transfer feature',
      ['src/portfolio/transfer.service.ts']
    );
    this.releaseService.updateCheckResult(
      checklist,
      'test_unit_coverage',
      CheckStatus.PASSED
    );

    // Process transfer with all safeguards in place
    return this.processTransfer(dto);
  }
}
```

---

## Monitoring & Alerts

### Redis HA Health

Monitor via logs:
```
INFO Redis client connected
INFO Redis client ready
WARN Redis client reconnecting delay=1000
WARN Redis reconnecting on recoverable error error=ECONNRESET
```

### Database Health

Schedule daily diagnostics:
```bash
# In your health check service
const health = await indexService.runIndexHealthDiagnostic();
metrics.gauge('database.fragmentation.high', health.summary.highSeverityFragmentation);
metrics.gauge('database.missing_fk_indexes.critical', health.summary.criticalMissingIndexes);
```

### Release Readiness

Track completion:
```typescript
const summary = checklistService.getReadinessSummary(checklist);
console.log(`Release readiness: ${summary.readinessPercent}%`);
if (summary.overallStatus === 'BLOCKED') {
  notifyOps('Release blocked: ' + summary.blockingIssues.join(', '));
}
```

---

## Best Practices

1. **Redis HA**: Configure multiple sentinels (≥3) for high availability
2. **Database Health**: Run diagnostics daily, especially before deployments
3. **Semantic Validation**: Add validation before ANY side effects (DB writes, API calls)
4. **Release Checklist**: Never skip CRITICAL checks - use waiver only with explicit approval

---

## Documentation References

- [RELEASE_READINESS.md](./RELEASE_READINESS.md) - Complete release checklist guide
- [cache-redis.factory.ts](../src/common/cache/cache-redis.factory.ts) - HA implementation
- [database-index.service.ts](../src/common/database/database-index.service.ts) - Diagnostics
- [semantic-validator.service.ts](../src/common/validation/semantic-validator.service.ts) - Validation
