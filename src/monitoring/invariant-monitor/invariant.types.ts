export enum InvariantSeverity {
  CRITICAL = "critical",
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
}

export enum InvariantCategory {
  FUNDS = "funds",
  OWNERSHIP = "ownership",
  LIFECYCLE = "lifecycle",
  AUTHORIZATION = "authorization",
}

export enum InvariantStatus {
  PASS = "pass",
  FAIL = "fail",
  WARN = "warn",
  ERROR = "error",
}

export interface InvariantResult {
  id: string;
  name: string;
  category: InvariantCategory;
  severity: InvariantSeverity;
  status: InvariantStatus;
  message: string;
  affectedRecordIds: string[];
  remediation: string;
  checkedAt: Date;
  durationMs: number;
  metadata?: Record<string, any>;
}

export interface InvariantReport {
  reportId: string;
  generatedAt: Date;
  totalChecks: number;
  passed: number;
  failed: number;
  warnings: number;
  errors: number;
  results: InvariantResult[];
  summary: string;
}

export interface InvariantCheckOutput {
  passed: boolean;
  warning?: boolean;
  message: string;
  affectedRecordIds: string[];
  metadata?: Record<string, any>;
}

export interface InvariantDefinition {
  id: string;
  name: string;
  description: string;
  category: InvariantCategory;
  severity: InvariantSeverity;
  remediation: string;
  check: () => Promise<InvariantCheckOutput>;
}
