export enum Role {
  USER = "USER",
  OPERATOR = "OPERATOR",
  MAINTAINER = "MAINTAINER",
  ADMIN = "ADMIN",
  GOVERNANCE_OPERATOR = "GOVERNANCE_OPERATOR",
  KYC_OPERATOR = "KYC_OPERATOR",
  SERVICE_ACTOR = "SERVICE_ACTOR",
}

/**
 * Granular permissions across API boundaries and service operations.
 */
export enum Permission {
  // User Management & Security
  USER_READ = "user:read",
  USER_WRITE = "user:write",
  USER_MANAGE = "user:manage",
  ROLE_ASSIGN = "role:assign",

  // Portfolio & Investments
  PORTFOLIO_READ = "portfolio:read",
  PORTFOLIO_WRITE = "portfolio:write",
  PORTFOLIO_OPTIMIZE = "portfolio:optimize",

  // Trading & DeFi Operations
  TRADE_READ = "trade:read",
  TRADE_EXECUTE = "trade:execute",

  // Payments & Stellar Reconciliation
  PAYMENT_CREATE = "payment:create",
  PAYMENT_PROCESS = "payment:process",
  PAYMENT_REFUND = "payment:refund",
  RECONCILIATION_VIEW = "reconciliation:view",
  RECONCILIATION_RUN = "reconciliation:run",

  // Oracle & Provenance
  ORACLE_READ = "oracle:read",
  ORACLE_SUBMIT = "oracle:submit",
  ORACLE_VERIFY = "oracle:verify",

  // Modules & Plugins
  MODULE_READ = "module:read",
  MODULE_MANAGE = "module:manage",

  // Monitoring, Metrics & Maintenance
  METRICS_READ = "metrics:read",
  SYSTEM_MAINTENANCE = "system:maintenance",
  ALERTS_MANAGE = "alerts:manage",
  RATE_LIMIT_MANAGE = "rate_limit:manage",

  // Specialised Operator Capabilities
  KYC_REVIEW = "kyc:review",
  GOVERNANCE_VOTE = "governance:vote",
  SERVICE_SYNC = "service:sync",

  // Retry & Job Management
  RETRY_VIEW = "retry:view",
  RETRY_MANAGE = "retry:manage",

  // Dead Letter Management
  DEAD_LETTER_VIEW = "dead_letter:view",
  DEAD_LETTER_RETRY = "dead_letter:retry",

  // Pause Controls
  PAUSE_VIEW = "pause:view",
  PAUSE_ACTIVATE = "pause:activate",
  PAUSE_RESUME = "pause:resume",

  // Invariant Monitoring
  INVARIANT_VIEW = "invariant:view",
  INVARIANT_RUN = "invariant:run",

  // Audit & Compliance
  AUDIT_READ = "audit:read",
  AUDIT_EXPORT = "audit:export",

  // Webhook Management
  WEBHOOK_READ = "webhook:read",
  WEBHOOK_MANAGE = "webhook:manage",

  // Import/Export
  IMPORT_EXECUTE = "import:execute",
  EXPORT_EXECUTE = "export:execute",

  // Disaster Recovery
  DR_VIEW = "dr:view",
  DR_EXECUTE = "dr:execute",
}

/**
 * UI Capabilities representation for client navigation and action gating.
 * Used by frontends to hide or disable unauthorized buttons while backend guards
 * enforce strict boundaries.
 */
export interface UiCapabilities {
  canTrade: boolean;
  canOptimize: boolean;
  canManageUsers: boolean;
  canAssignRoles: boolean;
  canRunReconciliation: boolean;
  canManageModules: boolean;
  canViewMetrics: boolean;
  canReviewKyc: boolean;
  canVoteGovernance: boolean;
  canSubmitOracle: boolean;
  canMaintainSystem: boolean;
  canExecuteServiceSync: boolean;
  canViewRetries: boolean;
  canManageRetries: boolean;
  canViewDeadLetters: boolean;
  canRetryDeadLetters: boolean;
  canViewPause: boolean;
  canActivatePause: boolean;
  canResumePause: boolean;
  canViewInvariants: boolean;
  canRunInvariants: boolean;
  canReadAudit: boolean;
  canExportAudit: boolean;
  canManageWebhooks: boolean;
  canImport: boolean;
  canExport: boolean;
  canViewDR: boolean;
  canExecuteDR: boolean;
}

/**
 * Every role value the system recognises, indexed by its canonical name.
 * Used by {@link normalizeRole} to coerce arbitrary input to a canonical Role.
 */
const ROLE_VALUES: Role[] = Object.values(Role);

/**
 * Coerce an arbitrary role value into a canonical {@link Role}.
 *
 * This is the single point of backwards compatibility for RBAC. Historically
 * roles were persisted and signed into JWTs in lowercase (e.g. "admin",
 * "kyc_operator"); the canonical form is now UPPERCASE. This function accepts
 * either casing (and surrounding whitespace) and maps it to the canonical enum.
 *
 * Unknown, empty, or missing values map to {@link Role.USER} — the least
 * privileged role — so tokens minted before roles existed default to
 * read-only access rather than being rejected or over-privileged.
 */
export function normalizeRole(value?: string | null): Role {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();

  return ROLE_VALUES.find((role) => role === normalized) ?? Role.USER;
}

/**
 * Linear privilege hierarchy for standard roles:
 * USER → OPERATOR → MAINTAINER → ADMIN.
 *
 * GOVERNANCE_OPERATOR, KYC_OPERATOR, and SERVICE_ACTOR sit outside the
 * linear hierarchy — they are specialised roles that require exact match,
 * with ADMIN superseding them all.
 */
export const ROLE_HIERARCHY: Role[] = [
  Role.USER,
  Role.OPERATOR,
  Role.MAINTAINER,
  Role.ADMIN,
];

/**
 * Pairs of roles that are mutually exclusive and cannot be assigned together.
 * GOVERNANCE_OPERATOR and KYC_OPERATOR must never be held by the same user.
 */
export const CONFLICTING_ROLE_PAIRS: [Role, Role][] = [
  [Role.GOVERNANCE_OPERATOR, Role.KYC_OPERATOR],
];

/**
 * Returns true if the given set of roles contains a conflicting pair.
 */
export function hasConflictingRoles(roles: Role[]): boolean {
  return CONFLICTING_ROLE_PAIRS.some(
    ([a, b]) => roles.includes(a) && roles.includes(b),
  );
}

/**
 * Permission assignment matrix for each canonical role.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.USER]: [
    Permission.USER_READ,
    Permission.USER_WRITE,
    Permission.PORTFOLIO_READ,
    Permission.PORTFOLIO_WRITE,
    Permission.TRADE_READ,
    Permission.PAYMENT_CREATE,
    Permission.ORACLE_READ,
    Permission.MODULE_READ,
  ],
  [Role.OPERATOR]: [
    Permission.USER_READ,
    Permission.USER_WRITE,
    Permission.PORTFOLIO_READ,
    Permission.PORTFOLIO_WRITE,
    Permission.PORTFOLIO_OPTIMIZE,
    Permission.TRADE_READ,
    Permission.TRADE_EXECUTE,
    Permission.PAYMENT_CREATE,
    Permission.PAYMENT_PROCESS,
    Permission.RECONCILIATION_VIEW,
    Permission.ORACLE_READ,
    Permission.ORACLE_VERIFY,
    Permission.MODULE_READ,
    Permission.METRICS_READ,
    Permission.RETRY_VIEW,
    Permission.DEAD_LETTER_VIEW,
    Permission.AUDIT_READ,
  ],
  [Role.MAINTAINER]: [
    Permission.USER_READ,
    Permission.USER_WRITE,
    Permission.PORTFOLIO_READ,
    Permission.PORTFOLIO_WRITE,
    Permission.PORTFOLIO_OPTIMIZE,
    Permission.TRADE_READ,
    Permission.TRADE_EXECUTE,
    Permission.PAYMENT_CREATE,
    Permission.PAYMENT_PROCESS,
    Permission.PAYMENT_REFUND,
    Permission.RECONCILIATION_VIEW,
    Permission.RECONCILIATION_RUN,
    Permission.ORACLE_READ,
    Permission.ORACLE_VERIFY,
    Permission.MODULE_READ,
    Permission.MODULE_MANAGE,
    Permission.METRICS_READ,
    Permission.ALERTS_MANAGE,
    Permission.RATE_LIMIT_MANAGE,
    Permission.SYSTEM_MAINTENANCE,
    Permission.RETRY_VIEW,
    Permission.RETRY_MANAGE,
    Permission.DEAD_LETTER_VIEW,
    Permission.PAUSE_VIEW,
    Permission.INVARIANT_VIEW,
    Permission.INVARIANT_RUN,
    Permission.AUDIT_READ,
    Permission.WEBHOOK_READ,
    Permission.EXPORT_EXECUTE,
    Permission.DR_VIEW,
  ],
  [Role.ADMIN]: Object.values(Permission),
  [Role.SERVICE_ACTOR]: [
    Permission.SERVICE_SYNC,
    Permission.ORACLE_SUBMIT,
    Permission.ORACLE_VERIFY,
    Permission.PAYMENT_PROCESS,
    Permission.RECONCILIATION_RUN,
    Permission.METRICS_READ,
    Permission.RETRY_VIEW,
    Permission.RETRY_MANAGE,
    Permission.DEAD_LETTER_VIEW,
  ],
  [Role.GOVERNANCE_OPERATOR]: [
    Permission.USER_READ,
    Permission.GOVERNANCE_VOTE,
    Permission.METRICS_READ,
  ],
  [Role.KYC_OPERATOR]: [
    Permission.USER_READ,
    Permission.KYC_REVIEW,
    Permission.METRICS_READ,
  ],
};

/**
 * Returns true if `candidate` satisfies the `required` role.
 *
 * Rules:
 *  1. Same role always satisfies itself.
 *  2. ADMIN supersedes every role.
 *  3. Specialised roles outside the linear hierarchy require an exact match
 *     unless candidate is ADMIN.
 *  4. Standard roles use the linear hierarchy comparison.
 */
export function hasRole(candidate: Role, required: Role): boolean {
  if (candidate === required) return true;
  if (candidate === Role.ADMIN) return true;

  const candidateIdx = ROLE_HIERARCHY.indexOf(candidate);
  const requiredIdx = ROLE_HIERARCHY.indexOf(required);

  // If either role is outside the linear hierarchy, fall back to exact equality
  if (candidateIdx === -1 || requiredIdx === -1) return false;

  return candidateIdx >= requiredIdx;
}

/**
 * Retrieve all permissions granted to a given role.
 */
export function getRolePermissions(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS[Role.USER];
}

/**
 * Returns true if the candidate role(s) grant the required permission.
 */
export function hasPermission(
  roleOrRoles: Role | Role[],
  required: Permission,
): boolean {
  const roles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  if (roles.includes(Role.ADMIN)) return true;

  return roles.some((role) => {
    const permissions = ROLE_PERMISSIONS[role] ?? [];
    return permissions.includes(required);
  });
}

/**
 * Returns true if the candidate role(s) grant ALL required permissions.
 */
export function hasAllPermissions(
  roleOrRoles: Role | Role[],
  required: Permission[],
): boolean {
  return required.every((perm) => hasPermission(roleOrRoles, perm));
}

/**
 * Compute the UI capabilities map for a given role or array of roles.
 * Client frontends query this to hide or disable unauthorized UI elements.
 */
export function getUiCapabilities(
  roleOrRoles: Role | Role[],
): UiCapabilities {
  return {
    canTrade: hasPermission(roleOrRoles, Permission.TRADE_EXECUTE),
    canOptimize: hasPermission(roleOrRoles, Permission.PORTFOLIO_OPTIMIZE),
    canManageUsers: hasPermission(roleOrRoles, Permission.USER_MANAGE),
    canAssignRoles: hasPermission(roleOrRoles, Permission.ROLE_ASSIGN),
    canRunReconciliation: hasPermission(
      roleOrRoles,
      Permission.RECONCILIATION_RUN,
    ),
    canManageModules: hasPermission(roleOrRoles, Permission.MODULE_MANAGE),
    canViewMetrics: hasPermission(roleOrRoles, Permission.METRICS_READ),
    canReviewKyc: hasPermission(roleOrRoles, Permission.KYC_REVIEW),
    canVoteGovernance: hasPermission(roleOrRoles, Permission.GOVERNANCE_VOTE),
    canSubmitOracle: hasPermission(roleOrRoles, Permission.ORACLE_SUBMIT),
    canMaintainSystem: hasPermission(roleOrRoles, Permission.SYSTEM_MAINTENANCE),
    canExecuteServiceSync: hasPermission(roleOrRoles, Permission.SERVICE_SYNC),
    canViewRetries: hasPermission(roleOrRoles, Permission.RETRY_VIEW),
    canManageRetries: hasPermission(roleOrRoles, Permission.RETRY_MANAGE),
    canViewDeadLetters: hasPermission(roleOrRoles, Permission.DEAD_LETTER_VIEW),
    canRetryDeadLetters: hasPermission(roleOrRoles, Permission.DEAD_LETTER_RETRY),
    canViewPause: hasPermission(roleOrRoles, Permission.PAUSE_VIEW),
    canActivatePause: hasPermission(roleOrRoles, Permission.PAUSE_ACTIVATE),
    canResumePause: hasPermission(roleOrRoles, Permission.PAUSE_RESUME),
    canViewInvariants: hasPermission(roleOrRoles, Permission.INVARIANT_VIEW),
    canRunInvariants: hasPermission(roleOrRoles, Permission.INVARIANT_RUN),
    canReadAudit: hasPermission(roleOrRoles, Permission.AUDIT_READ),
    canExportAudit: hasPermission(roleOrRoles, Permission.AUDIT_EXPORT),
    canManageWebhooks: hasPermission(roleOrRoles, Permission.WEBHOOK_MANAGE),
    canImport: hasPermission(roleOrRoles, Permission.IMPORT_EXECUTE),
    canExport: hasPermission(roleOrRoles, Permission.EXPORT_EXECUTE),
    canViewDR: hasPermission(roleOrRoles, Permission.DR_VIEW),
    canExecuteDR: hasPermission(roleOrRoles, Permission.DR_EXECUTE),
  };
}
