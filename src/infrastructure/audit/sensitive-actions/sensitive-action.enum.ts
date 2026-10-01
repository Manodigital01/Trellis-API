/**
 * Catalogue of actions that must leave a durable audit trail.
 *
 * Anything that moves value, changes access, touches user data, or flips
 * protocol behaviour belongs here: the audit service refuses to record an
 * action that is not declared, so a new sensitive path cannot be added without
 * a deliberate decision about its scope, whether a reason is mandatory, and
 * whether before/after state must be captured.
 */
export enum SensitiveActionScope {
  AUTHENTICATION = "authentication",
  ACCESS_CONTROL = "access-control",
  IDENTITY = "identity",
  TREASURY = "treasury",
  BILLING = "billing",
  RECONCILIATION = "reconciliation",
  DATA_EXPORT = "data-export",
  PROTOCOL_CONFIG = "protocol-config",
  COMPLIANCE = "compliance",
  PORTFOLIO = "portfolio",
}

export enum SensitiveAction {
  // Authentication
  LOGIN_SUCCEEDED = "auth.login.succeeded",
  LOGIN_FAILED = "auth.login.failed",
  LOGOUT_ALL_SESSIONS = "auth.sessions.revoked",
  PASSWORD_CHANGED = "auth.password.changed",
  MFA_ENROLLED = "auth.mfa.enrolled",
  MFA_RESET = "auth.mfa.reset",

  // Access control
  ROLE_ASSIGNED = "access.role.assigned",
  ROLE_REVOKED = "access.role.revoked",
  API_KEY_CREATED = "access.api-key.created",
  API_KEY_REVOKED = "access.api-key.revoked",
  IMPERSONATION_STARTED = "access.impersonation.started",
  IMPERSONATION_STOPPED = "access.impersonation.stopped",

  // Identity / user data
  USER_SUSPENDED = "identity.user.suspended",
  USER_REACTIVATED = "identity.user.reactivated",
  USER_DELETED = "identity.user.deleted",
  KYC_DECISION_RECORDED = "identity.kyc.decision",

  // Treasury
  WITHDRAWAL_APPROVED = "treasury.withdrawal.approved",
  WITHDRAWAL_REJECTED = "treasury.withdrawal.rejected",
  PAYOUT_INITIATED = "treasury.payout.initiated",
  WALLET_WHITELISTED = "treasury.wallet.whitelisted",

  // Billing
  INVOICE_MARKED_PAID = "billing.invoice.marked-paid",
  INVOICE_VOIDED = "billing.invoice.voided",
  REFUND_ISSUED = "billing.refund.issued",
  CREDIT_ADJUSTED = "billing.credit.adjusted",

  // Reconciliation
  RECONCILIATION_OVERRIDDEN = "reconciliation.override",
  RECONCILIATION_INVOICE_UPDATED = "reconciliation.invoice.updated",

  // Data export / compliance
  AUDIT_LOG_EXPORTED = "data.audit.exported",
  USER_DATA_EXPORTED = "data.user.exported",
  RETENTION_HOLD_PLACED = "compliance.retention-hold.placed",

  // Protocol configuration
  FEATURE_FLAG_CHANGED = "config.feature-flag.changed",
  EMERGENCY_PAUSE_TOGGLED = "config.emergency-pause.toggled",
  CONTRACT_UPGRADED = "config.contract.upgraded",

  // Portfolio ownership and value
  PORTFOLIO_RECORD_CHANGED = "portfolio.record.changed",

  // Core records lifecycle transitions
  LIFECYCLE_STATE_TRANSITION = "lifecycle.state.transition",
  PORTFOLIO_STATE_TRANSITION = "portfolio.state.transition",
  POSITION_STATE_TRANSITION = "defi.position.state.transition",
  TRANSACTION_STATE_TRANSITION = "transaction.state.transition",
}

export interface SensitiveActionDefinition {
  scope: SensitiveActionScope;
  description: string;
  /** A reason is mandatory — reviewers need to know *why*, not just *what*. */
  reasonRequired: boolean;
  /** `before`/`after` snapshots are captured for this action. */
  capturesState: boolean;
}

export const SENSITIVE_ACTION_CATALOGUE: Record<
  SensitiveAction,
  SensitiveActionDefinition
> = {
  [SensitiveAction.LOGIN_SUCCEEDED]: {
    scope: SensitiveActionScope.AUTHENTICATION,
    description: "A user or maintainer authenticated successfully.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.LOGIN_FAILED]: {
    scope: SensitiveActionScope.AUTHENTICATION,
    description: "An authentication attempt was rejected.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.LOGOUT_ALL_SESSIONS]: {
    scope: SensitiveActionScope.AUTHENTICATION,
    description: "Every active session for an actor was revoked.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.PASSWORD_CHANGED]: {
    scope: SensitiveActionScope.AUTHENTICATION,
    description: "An account password was changed.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.MFA_ENROLLED]: {
    scope: SensitiveActionScope.AUTHENTICATION,
    description: "A second factor was enrolled on an account.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.MFA_RESET]: {
    scope: SensitiveActionScope.AUTHENTICATION,
    description: "A second factor was reset by an operator or recovery flow.",
    reasonRequired: true,
    capturesState: false,
  },
  [SensitiveAction.ROLE_ASSIGNED]: {
    scope: SensitiveActionScope.ACCESS_CONTROL,
    description: "A role was granted to an actor.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.ROLE_REVOKED]: {
    scope: SensitiveActionScope.ACCESS_CONTROL,
    description: "A role was revoked from an actor.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.API_KEY_CREATED]: {
    scope: SensitiveActionScope.ACCESS_CONTROL,
    description: "An API credential was issued.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.API_KEY_REVOKED]: {
    scope: SensitiveActionScope.ACCESS_CONTROL,
    description: "An API credential was revoked.",
    reasonRequired: true,
    capturesState: false,
  },
  [SensitiveAction.IMPERSONATION_STARTED]: {
    scope: SensitiveActionScope.ACCESS_CONTROL,
    description: "A maintainer began acting on behalf of another actor.",
    reasonRequired: true,
    capturesState: false,
  },
  [SensitiveAction.IMPERSONATION_STOPPED]: {
    scope: SensitiveActionScope.ACCESS_CONTROL,
    description: "An impersonation session ended.",
    reasonRequired: false,
    capturesState: false,
  },
  [SensitiveAction.USER_SUSPENDED]: {
    scope: SensitiveActionScope.IDENTITY,
    description: "An account was suspended.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.USER_REACTIVATED]: {
    scope: SensitiveActionScope.IDENTITY,
    description: "A suspended account was reactivated.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.USER_DELETED]: {
    scope: SensitiveActionScope.IDENTITY,
    description: "An account was deleted or scheduled for erasure.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.KYC_DECISION_RECORDED]: {
    scope: SensitiveActionScope.IDENTITY,
    description: "A KYC/AML decision was recorded for an account.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.WITHDRAWAL_APPROVED]: {
    scope: SensitiveActionScope.TREASURY,
    description: "A withdrawal request was approved.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.WITHDRAWAL_REJECTED]: {
    scope: SensitiveActionScope.TREASURY,
    description: "A withdrawal request was rejected.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.PAYOUT_INITIATED]: {
    scope: SensitiveActionScope.TREASURY,
    description: "An outbound payout was initiated.",
    reasonRequired: false,
    capturesState: true,
  },
  [SensitiveAction.WALLET_WHITELISTED]: {
    scope: SensitiveActionScope.TREASURY,
    description: "A destination wallet was added to the payout allow-list.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.INVOICE_MARKED_PAID]: {
    scope: SensitiveActionScope.BILLING,
    description: "An invoice was manually marked as paid.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.INVOICE_VOIDED]: {
    scope: SensitiveActionScope.BILLING,
    description: "An invoice was voided.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.REFUND_ISSUED]: {
    scope: SensitiveActionScope.BILLING,
    description: "A refund was issued to a customer.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.CREDIT_ADJUSTED]: {
    scope: SensitiveActionScope.BILLING,
    description: "An account credit balance was adjusted manually.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.RECONCILIATION_OVERRIDDEN]: {
    scope: SensitiveActionScope.RECONCILIATION,
    description: "A reconciliation decision was overridden by an operator.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.RECONCILIATION_INVOICE_UPDATED]: {
    scope: SensitiveActionScope.RECONCILIATION,
    description: "An invoice's reconciliation fields were edited.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.AUDIT_LOG_EXPORTED]: {
    scope: SensitiveActionScope.DATA_EXPORT,
    description: "Audit records were exported for review.",
    reasonRequired: true,
    capturesState: false,
  },
  [SensitiveAction.USER_DATA_EXPORTED]: {
    scope: SensitiveActionScope.DATA_EXPORT,
    description: "User data was exported (DSAR or support request).",
    reasonRequired: true,
    capturesState: false,
  },
  [SensitiveAction.RETENTION_HOLD_PLACED]: {
    scope: SensitiveActionScope.COMPLIANCE,
    description: "A retention hold was placed to protect records from purge.",
    reasonRequired: true,
    capturesState: false,
  },
  [SensitiveAction.FEATURE_FLAG_CHANGED]: {
    scope: SensitiveActionScope.PROTOCOL_CONFIG,
    description: "A feature flag was enabled, disabled, or re-weighted.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.EMERGENCY_PAUSE_TOGGLED]: {
    scope: SensitiveActionScope.PROTOCOL_CONFIG,
    description: "The emergency pause switch was toggled.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.CONTRACT_UPGRADED]: {
    scope: SensitiveActionScope.PROTOCOL_CONFIG,
    description: "A contract was upgraded or its WASM hash changed.",
    reasonRequired: true,
    capturesState: true,
  },
  [SensitiveAction.PORTFOLIO_RECORD_CHANGED]: {
    scope: SensitiveActionScope.PORTFOLIO,
    description: "A portfolio or holding affecting ownership or value changed.",
    reasonRequired: false,
    capturesState: true,
  },
  [SensitiveAction.PORTFOLIO_STATE_TRANSITION]: {
    scope: SensitiveActionScope.PORTFOLIO,
    description: "A portfolio transitioned between deterministic lifecycle states.",
    reasonRequired: false,
    capturesState: true,
  },
  [SensitiveAction.POSITION_STATE_TRANSITION]: {
    scope: SensitiveActionScope.PROTOCOL_CONFIG,
    description: "A DeFi position transitioned lifecycle state.",
    reasonRequired: false,
    capturesState: true,
  },
  [SensitiveAction.TRANSACTION_STATE_TRANSITION]: {
    scope: SensitiveActionScope.TREASURY,
    description: "A transaction transitioned lifecycle state.",
    reasonRequired: false,
    capturesState: true,
  },
  [SensitiveAction.LIFECYCLE_STATE_TRANSITION]: {
    scope: SensitiveActionScope.COMPLIANCE,
    description: "A core record underwent a deterministic lifecycle state transition.",
    reasonRequired: false,
    capturesState: true,
  },
};

export const SENSITIVE_ACTIONS = Object.values(SensitiveAction);

export function isSensitiveAction(value: unknown): value is SensitiveAction {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SENSITIVE_ACTION_CATALOGUE, value)
  );
}

export function describeSensitiveAction(
  action: SensitiveAction
): SensitiveActionDefinition {
  return SENSITIVE_ACTION_CATALOGUE[action];
}
