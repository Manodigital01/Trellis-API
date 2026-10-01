import { Role, Permission, hasAllPermissions } from "./roles.enum";

export interface PermissionMatrixEntry {
  action: string;
  description: string;
  requiredPermissions: Permission[];
  allowedRoles: Role[];
  scope: "global" | "tenant" | "own";
  sensitive: boolean;
  auditRequired: boolean;
}

export const PERMISSION_MATRIX: PermissionMatrixEntry[] = [
  // User Management
  {
    action: "user.read",
    description: "View user profiles and details",
    requiredPermissions: [Permission.USER_READ],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "user.write",
    description: "Update user profile information",
    requiredPermissions: [Permission.USER_WRITE],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "user.manage",
    description: "Manage user accounts (suspend, delete, modify)",
    requiredPermissions: [Permission.USER_MANAGE],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "role.assign",
    description: "Assign or revoke roles for users",
    requiredPermissions: [Permission.ROLE_ASSIGN],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Portfolio & Investment
  {
    action: "portfolio.read",
    description: "View portfolio data",
    requiredPermissions: [Permission.PORTFOLIO_READ],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "portfolio.write",
    description: "Create or modify portfolios",
    requiredPermissions: [Permission.PORTFOLIO_WRITE],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "portfolio.optimize",
    description: "Run portfolio optimization algorithms",
    requiredPermissions: [Permission.PORTFOLIO_OPTIMIZE],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: false,
    auditRequired: true,
  },

  // Trading
  {
    action: "trade.read",
    description: "View trade history and status",
    requiredPermissions: [Permission.TRADE_READ],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "trade.execute",
    description: "Execute trades on behalf of portfolios",
    requiredPermissions: [Permission.TRADE_EXECUTE],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: true,
    auditRequired: true,
  },

  // Payments
  {
    action: "payment.create",
    description: "Create a new payment",
    requiredPermissions: [Permission.PAYMENT_CREATE],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "own",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "payment.process",
    description: "Process pending payments",
    requiredPermissions: [Permission.PAYMENT_PROCESS],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "payment.refund",
    description: "Issue payment refunds",
    requiredPermissions: [Permission.PAYMENT_REFUND],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Reconciliation
  {
    action: "reconciliation.view",
    description: "View reconciliation reports",
    requiredPermissions: [Permission.RECONCILIATION_VIEW],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "reconciliation.run",
    description: "Run reconciliation processes",
    requiredPermissions: [Permission.RECONCILIATION_RUN],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Oracle
  {
    action: "oracle.read",
    description: "Read oracle price feeds",
    requiredPermissions: [Permission.ORACLE_READ],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "oracle.submit",
    description: "Submit oracle price data",
    requiredPermissions: [Permission.ORACLE_SUBMIT],
    allowedRoles: [Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "oracle.verify",
    description: "Verify oracle submissions",
    requiredPermissions: [Permission.ORACLE_VERIFY],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: false,
    auditRequired: true,
  },

  // Modules
  {
    action: "module.read",
    description: "View registered modules",
    requiredPermissions: [Permission.MODULE_READ],
    allowedRoles: [Role.USER, Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "module.manage",
    description: "Enable, disable, or configure modules",
    requiredPermissions: [Permission.MODULE_MANAGE],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Monitoring & Metrics
  {
    action: "metrics.read",
    description: "View system metrics and dashboards",
    requiredPermissions: [Permission.METRICS_READ],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "system.maintenance",
    description: "Perform system maintenance operations",
    requiredPermissions: [Permission.SYSTEM_MAINTENANCE],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "alerts.manage",
    description: "Configure and manage system alerts",
    requiredPermissions: [Permission.ALERTS_MANAGE],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: true,
  },
  {
    action: "rate_limit.manage",
    description: "Configure rate limiting policies",
    requiredPermissions: [Permission.RATE_LIMIT_MANAGE],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Retry & Dead Letter Management
  {
    action: "retry.view",
    description: "View retry operation status",
    requiredPermissions: [Permission.RETRY_VIEW],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "retry.manage",
    description: "Schedule and manage retry operations",
    requiredPermissions: [Permission.RETRY_MANAGE],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: false,
    auditRequired: true,
  },
  {
    action: "dead_letter.view",
    description: "View dead-lettered operations",
    requiredPermissions: [Permission.DEAD_LETTER_VIEW],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN, Role.SERVICE_ACTOR],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "dead_letter.retry",
    description: "Retry dead-lettered operations",
    requiredPermissions: [Permission.DEAD_LETTER_RETRY],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Pause Controls
  {
    action: "pause.view",
    description: "View active pauses and history",
    requiredPermissions: [Permission.PAUSE_VIEW],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "pause.activate",
    description: "Activate emergency pause on operations",
    requiredPermissions: [Permission.PAUSE_ACTIVATE],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "pause.resume",
    description: "Resume paused operations",
    requiredPermissions: [Permission.PAUSE_RESUME],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Invariant Monitoring
  {
    action: "invariant.view",
    description: "View invariant monitoring reports",
    requiredPermissions: [Permission.INVARIANT_VIEW],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "invariant.run",
    description: "Run invariant checks",
    requiredPermissions: [Permission.INVARIANT_RUN],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: true,
  },

  // Audit
  {
    action: "audit.read",
    description: "Read audit logs",
    requiredPermissions: [Permission.AUDIT_READ],
    allowedRoles: [Role.OPERATOR, Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "audit.export",
    description: "Export audit data",
    requiredPermissions: [Permission.AUDIT_EXPORT],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Webhooks
  {
    action: "webhook.read",
    description: "View webhook subscriptions and delivery logs",
    requiredPermissions: [Permission.WEBHOOK_READ],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "webhook.manage",
    description: "Create, update, or delete webhook subscriptions",
    requiredPermissions: [Permission.WEBHOOK_MANAGE],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Import/Export
  {
    action: "import.execute",
    description: "Execute data import operations",
    requiredPermissions: [Permission.IMPORT_EXECUTE],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "export.execute",
    description: "Execute data export operations",
    requiredPermissions: [Permission.EXPORT_EXECUTE],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: true,
  },

  // Disaster Recovery
  {
    action: "dr.view",
    description: "View disaster recovery status and backups",
    requiredPermissions: [Permission.DR_VIEW],
    allowedRoles: [Role.MAINTAINER, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: false,
  },
  {
    action: "dr.execute",
    description: "Execute disaster recovery operations",
    requiredPermissions: [Permission.DR_EXECUTE],
    allowedRoles: [Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },

  // Specialised
  {
    action: "kyc.review",
    description: "Review KYC applications",
    requiredPermissions: [Permission.KYC_REVIEW],
    allowedRoles: [Role.KYC_OPERATOR, Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "governance.vote",
    description: "Vote on governance proposals",
    requiredPermissions: [Permission.GOVERNANCE_VOTE],
    allowedRoles: [Role.GOVERNANCE_OPERATOR, Role.ADMIN],
    scope: "global",
    sensitive: true,
    auditRequired: true,
  },
  {
    action: "service.sync",
    description: "Execute service-to-service synchronization",
    requiredPermissions: [Permission.SERVICE_SYNC],
    allowedRoles: [Role.SERVICE_ACTOR, Role.ADMIN],
    scope: "global",
    sensitive: false,
    auditRequired: true,
  },
];

const matrixIndex = new Map<string, PermissionMatrixEntry>(
  PERMISSION_MATRIX.map((entry) => [entry.action, entry]),
);

export function getActionPermissions(
  action: string,
): PermissionMatrixEntry | undefined {
  return matrixIndex.get(action);
}

export function getActionsForRole(role: Role): PermissionMatrixEntry[] {
  if (role === Role.ADMIN) return [...PERMISSION_MATRIX];
  return PERMISSION_MATRIX.filter((entry) =>
    entry.allowedRoles.includes(role),
  );
}

export function isActionAllowed(
  roles: Role[],
  action: string,
): boolean {
  if (roles.includes(Role.ADMIN)) return true;

  const entry = matrixIndex.get(action);
  if (!entry) return false;

  return hasAllPermissions(roles, entry.requiredPermissions);
}

export function getSensitiveActions(): PermissionMatrixEntry[] {
  return PERMISSION_MATRIX.filter((entry) => entry.sensitive);
}

export function getAuditableActions(): PermissionMatrixEntry[] {
  return PERMISSION_MATRIX.filter((entry) => entry.auditRequired);
}
