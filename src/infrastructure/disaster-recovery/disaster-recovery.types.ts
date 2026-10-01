export enum InvariantCategory {
  AUTH_AND_IDENTITY = 'AUTH_AND_IDENTITY',
  PORTFOLIO_AND_INVESTMENT = 'PORTFOLIO_AND_INVESTMENT',
  BLOCKCHAIN_AND_ORACLE = 'BLOCKCHAIN_AND_ORACLE',
  RECONCILIATION_AND_SETTLEMENT = 'RECONCILIATION_AND_SETTLEMENT',
  DEFI_AND_POSITIONS = 'DEFI_AND_POSITIONS',
  AUDIT_AND_PROVENANCE = 'AUDIT_AND_PROVENANCE',
  NOTIFICATIONS_AND_ALERTS = 'NOTIFICATIONS_AND_ALERTS',
}

export enum InvariantSeverity {
  CRITICAL = 'CRITICAL',
  ERROR = 'ERROR',
  WARNING = 'WARNING',
}

export interface InvariantViolation {
  id?: string;
  entity: string;
  description: string;
  sampleData?: Record<string, any>;
}

export interface InvariantCheckResult {
  code: string;
  name: string;
  category: InvariantCategory;
  severity: InvariantSeverity;
  passed: boolean;
  violationCount: number;
  description: string;
  remediation: string;
  violations?: InvariantViolation[];
}

export interface DisasterRecoveryValidationReport {
  timestamp: Date;
  isConsistent: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  criticalFailures: number;
  errorFailures: number;
  warningFailures: number;
  executionTimeMs: number;
  results: InvariantCheckResult[];
}
