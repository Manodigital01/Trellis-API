/**
 * Release Readiness Checklist for critical Trellis API changes.
 *
 * This checklist ensures that critical changes meet production readiness standards
 * before merge or deployment. Each check has an acceptance criterion and severity level.
 */

export enum CheckSeverity {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
}

export enum CheckStatus {
  NOT_STARTED = "NOT_STARTED",
  IN_PROGRESS = "IN_PROGRESS",
  PASSED = "PASSED",
  FAILED = "FAILED",
  BLOCKED = "BLOCKED",
  WAIVED = "WAIVED",
}

export interface ReleaseCheck {
  id: string;
  category: "tests" | "migrations" | "config" | "docs" | "rollback" | "performance";
  name: string;
  description: string;
  acceptanceCriterion: string;
  severity: CheckSeverity;
  automatable: boolean;
  automationCommand?: string;
  estimatedTimeMinutes: number;
  responsible?: string;
}

export interface CheckResult {
  checkId: string;
  status: CheckStatus;
  passedAt?: Date;
  failureReason?: string;
  evidenceUrl?: string;
  waiverReason?: string;
  waiverApprovedBy?: string;
  notes?: string;
}

export interface ReleaseChecklist {
  prNumber: string;
  title: string;
  isCriticalChange: boolean;
  checks: ReleaseCheck[];
  results: Map<string, CheckResult>;
  overallStatus: "READY" | "NEEDS_ATTENTION" | "BLOCKED";
  createdAt: Date;
  updatedAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
}

/**
 * Comprehensive release checklist for critical Trellis API changes.
 */
export const TRELLIS_API_RELEASE_CHECKS: ReleaseCheck[] = [
  // =========================================================================
  // Tests
  // =========================================================================
  {
    id: "test_unit_coverage",
    category: "tests",
    name: "Unit Test Coverage",
    description: "All new code paths have corresponding unit tests",
    acceptanceCriterion:
      "Coverage report shows ≥80% coverage for changed files; npm run test:coverage passes",
    severity: CheckSeverity.CRITICAL,
    automatable: true,
    automationCommand: "npm run test:coverage",
    estimatedTimeMinutes: 30,
  },
  {
    id: "test_integration",
    category: "tests",
    name: "Integration Tests",
    description: "End-to-end integration tests pass with production-like DB",
    acceptanceCriterion: "npm run test:integration passes; no flaky test runs",
    severity: CheckSeverity.HIGH,
    automatable: true,
    automationCommand: "npm run test:integration",
    estimatedTimeMinutes: 45,
  },
  {
    id: "test_edge_cases",
    category: "tests",
    name: "Edge Case Tests",
    description: "Boundary conditions and error paths are tested",
    acceptanceCriterion: "Tests cover happy path, sad paths, and 2+ edge cases per feature",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 60,
  },

  // =========================================================================
  // Migrations
  // =========================================================================
  {
    id: "migration_reversibility",
    category: "migrations",
    name: "Migration Reversibility",
    description:
      "All database migrations are reversible without data loss (down() functions)",
    acceptanceCriterion:
      "Every migration has a down() function; tested locally: up() then down() then up() again",
    severity: CheckSeverity.CRITICAL,
    automatable: false,
    estimatedTimeMinutes: 30,
  },
  {
    id: "migration_locking",
    category: "migrations",
    name: "No Long Locks",
    description: "Migrations avoid LOCK TABLE or ALTER TABLE RENAME on large tables",
    acceptanceCriterion: "No exclusive locks; uses CONCURRENTLY for index creation",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 15,
  },
  {
    id: "migration_backfill",
    category: "migrations",
    name: "Safe Backfill",
    description: "Backfills are tested with realistic data volumes",
    acceptanceCriterion: "Backfill tested on ≥100k rows; no timeouts or OOM conditions",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 45,
  },

  // =========================================================================
  // Configuration
  // =========================================================================
  {
    id: "config_env_validation",
    category: "config",
    name: "Environment Validation",
    description:
      "All required environment variables are documented and validated at startup",
    acceptanceCriterion:
      ".env.example updated; ConfigService validates missing keys on boot; docs/CONFIG.md updated",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 20,
  },
  {
    id: "config_secrets",
    category: "config",
    name: "Secrets Not Committed",
    description: "No secrets, API keys, or credentials in code or Git history",
    acceptanceCriterion: 'git log -p shows no secrets; .env is in .gitignore; npm audit passes',
    severity: CheckSeverity.CRITICAL,
    automatable: true,
    automationCommand: "npm audit && git log --all --oneline -- .env",
    estimatedTimeMinutes: 10,
  },
  {
    id: "config_feature_flags",
    category: "config",
    name: "Feature Flags for Risky Changes",
    description: "Risky or incomplete features are behind feature flags",
    acceptanceCriterion: "Feature disabled by default; can be toggled without redeployment",
    severity: CheckSeverity.MEDIUM,
    automatable: false,
    estimatedTimeMinutes: 20,
  },

  // =========================================================================
  // Documentation
  // =========================================================================
  {
    id: "docs_api_contracts",
    category: "docs",
    name: "API Contract Updated",
    description:
      "OpenAPI/GraphQL schema and API documentation reflect all changes",
    acceptanceCriterion:
      "docs/API.md or openapi.json updated; no breaking changes without major version bump",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 30,
  },
  {
    id: "docs_deployment",
    category: "docs",
    name: "Deployment Steps Documented",
    description: "Deployment, migration order, and rollback procedures are documented",
    acceptanceCriterion:
      "docs/DEPLOYMENT.md or PR description includes step-by-step instructions",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 25,
  },
  {
    id: "docs_breaking_changes",
    category: "docs",
    name: "Breaking Changes Documented",
    description: "If changes are breaking, CHANGELOG.md includes migration guide",
    acceptanceCriterion: "CHANGELOG.md updated; migration guide links from docs",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 20,
  },

  // =========================================================================
  // Rollback
  // =========================================================================
  {
    id: "rollback_procedure",
    category: "rollback",
    name: "Rollback Procedure Defined",
    description: "Clear steps to roll back code, config, and database changes",
    acceptanceCriterion:
      "docs/RUNBOOK.md includes rollback section; tested on staging or locally",
    severity: CheckSeverity.CRITICAL,
    automatable: false,
    estimatedTimeMinutes: 40,
  },
  {
    id: "rollback_data_safety",
    category: "rollback",
    name: "Data Safety During Rollback",
    description: "Rollback does not cause data loss or corruption",
    acceptanceCriterion:
      "Backward compatibility maintained; new columns can be null; old code works with new schema",
    severity: CheckSeverity.CRITICAL,
    automatable: false,
    estimatedTimeMinutes: 30,
  },
  {
    id: "rollback_monitoring",
    category: "rollback",
    name: "Rollback Monitoring",
    description: "Metrics and alerts are in place to detect rollback issues",
    acceptanceCriterion:
      "Error rate, latency, and data consistency metrics are monitored; alerts configured",
    severity: CheckSeverity.HIGH,
    automatable: false,
    estimatedTimeMinutes: 30,
  },

  // =========================================================================
  // Performance
  // =========================================================================
  {
    id: "perf_no_regression",
    category: "performance",
    name: "No Performance Regression",
    description: "Query latency, memory, and throughput do not degrade",
    acceptanceCriterion:
      "Benchmark tests pass; no new O(n²) algorithms; database queries are indexed",
    severity: CheckSeverity.HIGH,
    automatable: true,
    automationCommand: "npm run bench",
    estimatedTimeMinutes: 45,
  },
  {
    id: "perf_scaling",
    category: "performance",
    name: "Scaling Assumptions Documented",
    description: "Known scaling limits and constraints are documented",
    acceptanceCriterion:
      "Docs include max rows per table, rate limits, or async job queue behavior",
    severity: CheckSeverity.MEDIUM,
    automatable: false,
    estimatedTimeMinutes: 15,
  },
];

/**
 * Determine if a PR is considered "critical" and requires the full checklist.
 *
 * Critical changes include:
 * - Schema/migration changes
 * - Authentication or authorization changes
 * - Payment/billing logic
 * - Data export or privacy-sensitive features
 */
export function isCriticalChange(prTitle: string, files: string[]): boolean {
  const criticalPatterns = [
    /migration|schema|database/i,
    /auth|permission|rbac|security/i,
    /payment|billing|invoice/i,
    /export|privacy|gdpr|pii/i,
    /config|deployment/i,
  ];

  const titleMatches = criticalPatterns.some((p) => p.test(prTitle));
  const fileMatches = files.some((f) =>
    /migration|auth|payment|billing|export|security/i.test(f),
  );

  return titleMatches || fileMatches;
}

/**
 * Calculate overall readiness status based on check results.
 */
export function calculateReleaseStatus(results: Map<string, CheckResult>): "READY" | "NEEDS_ATTENTION" | "BLOCKED" {
  if (results.size === 0) return "NEEDS_ATTENTION";

  let hasBlocker = false;
  let allPassed = true;

  for (const result of results.values()) {
    if (result.status === CheckStatus.BLOCKED) {
      hasBlocker = true;
    }
    if (result.status === CheckStatus.FAILED && result.status !== CheckStatus.WAIVED) {
      hasBlocker = true;
    }
    if (result.status !== CheckStatus.PASSED && result.status !== CheckStatus.WAIVED) {
      allPassed = false;
    }
  }

  if (hasBlocker) return "BLOCKED";
  if (!allPassed) return "NEEDS_ATTENTION";
  return "READY";
}
