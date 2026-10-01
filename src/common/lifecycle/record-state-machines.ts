import {
  StateMachineDefinition,
  TransitionContext,
} from "./state-machine.interface";
import { DeterministicStateMachine } from "./deterministic-state-machine";

// ============================================================================
// 1. PORTFOLIO LIFECYCLE
// ============================================================================

export enum PortfolioLifecycleState {
  DRAFT = "draft",
  ACTIVE = "active",
  REBALANCING = "rebalancing",
  PAUSED = "paused",
  FROZEN = "frozen",
  ARCHIVED = "archived",
}

export const PORTFOLIO_STATE_MACHINE_DEF: StateMachineDefinition<PortfolioLifecycleState> = {
  name: "Portfolio",
  initialState: PortfolioLifecycleState.ACTIVE,
  states: {
    [PortfolioLifecycleState.DRAFT]: {
      state: PortfolioLifecycleState.DRAFT,
      displayName: "Draft",
      description: "Initial configuration in progress before activation",
      isTerminal: false,
      isLocked: false,
    },
    [PortfolioLifecycleState.ACTIVE]: {
      state: PortfolioLifecycleState.ACTIVE,
      displayName: "Active",
      description: "Portfolio is live and operational for trading and rebalancing",
      isTerminal: false,
      isLocked: false,
    },
    [PortfolioLifecycleState.REBALANCING]: {
      state: PortfolioLifecycleState.REBALANCING,
      displayName: "Rebalancing",
      description: "Portfolio is undergoing an active rebalance execution window",
      isTerminal: false,
      isLocked: true,
    },
    [PortfolioLifecycleState.PAUSED]: {
      state: PortfolioLifecycleState.PAUSED,
      displayName: "Paused",
      description: "Trading and automated rebalancing operations are temporarily halted",
      isTerminal: false,
      isLocked: true,
    },
    [PortfolioLifecycleState.FROZEN]: {
      state: PortfolioLifecycleState.FROZEN,
      displayName: "Frozen",
      description: "Emergency hold or circuit-breaker locked state",
      isTerminal: false,
      isLocked: true,
    },
    [PortfolioLifecycleState.ARCHIVED]: {
      state: PortfolioLifecycleState.ARCHIVED,
      displayName: "Archived",
      description: "Portfolio has been retired / soft-deleted",
      isTerminal: true,
      isLocked: true,
    },
  },
  transitions: [
    // From DRAFT
    {
      from: PortfolioLifecycleState.DRAFT,
      to: PortfolioLifecycleState.ACTIVE,
      description: "Activate portfolio with confirmed allocation",
    },
    {
      from: PortfolioLifecycleState.DRAFT,
      to: PortfolioLifecycleState.ARCHIVED,
      description: "Discard draft portfolio",
    },

    // From ACTIVE
    {
      from: PortfolioLifecycleState.ACTIVE,
      to: PortfolioLifecycleState.REBALANCING,
      description: "Initiate portfolio rebalance execution",
    },
    {
      from: PortfolioLifecycleState.ACTIVE,
      to: PortfolioLifecycleState.PAUSED,
      description: "Pause portfolio trading and automation",
    },
    {
      from: PortfolioLifecycleState.ACTIVE,
      to: PortfolioLifecycleState.FROZEN,
      description: "Emergency freeze / circuit breaker trip",
    },
    {
      from: PortfolioLifecycleState.ACTIVE,
      to: PortfolioLifecycleState.ARCHIVED,
      description: "Archive active portfolio",
    },

    // From REBALANCING
    {
      from: PortfolioLifecycleState.REBALANCING,
      to: PortfolioLifecycleState.ACTIVE,
      description: "Complete rebalance and restore active trading",
    },
    {
      from: PortfolioLifecycleState.REBALANCING,
      to: PortfolioLifecycleState.PAUSED,
      description: "Pause portfolio following rebalance completion or abort",
    },
    {
      from: PortfolioLifecycleState.REBALANCING,
      to: PortfolioLifecycleState.FROZEN,
      description: "Freeze portfolio due to rebalance failure / invariant violation",
    },

    // From PAUSED
    {
      from: PortfolioLifecycleState.PAUSED,
      to: PortfolioLifecycleState.ACTIVE,
      description: "Resume portfolio trading",
    },
    {
      from: PortfolioLifecycleState.PAUSED,
      to: PortfolioLifecycleState.FROZEN,
      description: "Elevate paused portfolio to emergency freeze",
    },
    {
      from: PortfolioLifecycleState.PAUSED,
      to: PortfolioLifecycleState.ARCHIVED,
      description: "Archive paused portfolio",
    },

    // From FROZEN
    {
      from: PortfolioLifecycleState.FROZEN,
      to: PortfolioLifecycleState.ACTIVE,
      description: "Unfreeze portfolio after risk review / circuit reset",
    },
    {
      from: PortfolioLifecycleState.FROZEN,
      to: PortfolioLifecycleState.PAUSED,
      description: "Transition frozen portfolio to paused for maintenance",
    },
    {
      from: PortfolioLifecycleState.FROZEN,
      to: PortfolioLifecycleState.ARCHIVED,
      description: "Archive frozen portfolio",
    },
  ],
};

export const PortfolioStateMachine = new DeterministicStateMachine<PortfolioLifecycleState>(
  PORTFOLIO_STATE_MACHINE_DEF,
);

// ============================================================================
// 2. TRANSACTION / TRADE LIFECYCLE
// ============================================================================

export enum TransactionLifecycleState {
  PENDING = "pending",
  SUBMITTED = "submitted",
  CONFIRMED = "confirmed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  TIMED_OUT = "timed_out",
  REVERTED = "reverted",
}

export const TRANSACTION_STATE_MACHINE_DEF: StateMachineDefinition<TransactionLifecycleState> = {
  name: "Transaction",
  initialState: TransactionLifecycleState.PENDING,
  states: {
    [TransactionLifecycleState.PENDING]: {
      state: TransactionLifecycleState.PENDING,
      displayName: "Pending",
      description: "Transaction initialized and undergoing preflight validation",
      isTerminal: false,
    },
    [TransactionLifecycleState.SUBMITTED]: {
      state: TransactionLifecycleState.SUBMITTED,
      displayName: "Submitted",
      description: "Transaction signed and broadcasted to network",
      isTerminal: false,
    },
    [TransactionLifecycleState.CONFIRMED]: {
      state: TransactionLifecycleState.CONFIRMED,
      displayName: "Confirmed",
      description: "Transaction mined and settled on-chain",
      isTerminal: true,
    },
    [TransactionLifecycleState.FAILED]: {
      state: TransactionLifecycleState.FAILED,
      displayName: "Failed",
      description: "Transaction rejected or failed during submission",
      isTerminal: true,
    },
    [TransactionLifecycleState.CANCELLED]: {
      state: TransactionLifecycleState.CANCELLED,
      displayName: "Cancelled",
      description: "Transaction cancelled before network broadcast",
      isTerminal: true,
    },
    [TransactionLifecycleState.TIMED_OUT]: {
      state: TransactionLifecycleState.TIMED_OUT,
      displayName: "Timed Out",
      description: "Transaction exceeded deadline without on-chain confirmation",
      isTerminal: true,
    },
    [TransactionLifecycleState.REVERTED]: {
      state: TransactionLifecycleState.REVERTED,
      displayName: "Reverted",
      description: "Transaction execution reverted by smart contract",
      isTerminal: true,
    },
  },
  transitions: [
    // From PENDING
    {
      from: TransactionLifecycleState.PENDING,
      to: TransactionLifecycleState.SUBMITTED,
      description: "Broadcast signed transaction to network",
    },
    {
      from: TransactionLifecycleState.PENDING,
      to: TransactionLifecycleState.CANCELLED,
      description: "Cancel transaction prior to network broadcast",
    },
    {
      from: TransactionLifecycleState.PENDING,
      to: TransactionLifecycleState.FAILED,
      description: "Preflight failure or signing rejection",
    },

    // From SUBMITTED
    {
      from: TransactionLifecycleState.SUBMITTED,
      to: TransactionLifecycleState.CONFIRMED,
      description: "On-chain transaction settlement confirmed",
    },
    {
      from: TransactionLifecycleState.SUBMITTED,
      to: TransactionLifecycleState.FAILED,
      description: "Network node rejected transaction",
    },
    {
      from: TransactionLifecycleState.SUBMITTED,
      to: TransactionLifecycleState.TIMED_OUT,
      description: "Transaction inclusion deadline expired",
    },
    {
      from: TransactionLifecycleState.SUBMITTED,
      to: TransactionLifecycleState.REVERTED,
      description: "Contract reverted during on-chain execution",
    },
  ],
};

export const TransactionStateMachine = new DeterministicStateMachine<TransactionLifecycleState>(
  TRANSACTION_STATE_MACHINE_DEF,
);

// ============================================================================
// 3. DEFI POSITION LIFECYCLE
// ============================================================================

export enum DeFiPositionLifecycleState {
  ACTIVE = "active",
  PAUSED = "paused",
  LIQUIDATION_RISK = "liquidation_risk",
  CLOSED = "closed",
  LIQUIDATED = "liquidated",
}

export const DEFI_POSITION_STATE_MACHINE_DEF: StateMachineDefinition<DeFiPositionLifecycleState> = {
  name: "DeFiPosition",
  initialState: DeFiPositionLifecycleState.ACTIVE,
  states: {
    [DeFiPositionLifecycleState.ACTIVE]: {
      state: DeFiPositionLifecycleState.ACTIVE,
      displayName: "Active",
      description: "Position is active and accruing yield or providing collateral",
      isTerminal: false,
    },
    [DeFiPositionLifecycleState.PAUSED]: {
      state: DeFiPositionLifecycleState.PAUSED,
      displayName: "Paused",
      description: "Protocol or user paused interactions with this position",
      isTerminal: false,
    },
    [DeFiPositionLifecycleState.LIQUIDATION_RISK]: {
      state: DeFiPositionLifecycleState.LIQUIDATION_RISK,
      displayName: "Liquidation Risk",
      description: "Collateral ratio is near or below safety threshold",
      isTerminal: false,
    },
    [DeFiPositionLifecycleState.CLOSED]: {
      state: DeFiPositionLifecycleState.CLOSED,
      displayName: "Closed",
      description: "Position has been voluntarily unwound / withdrawn in full",
      isTerminal: true,
    },
    [DeFiPositionLifecycleState.LIQUIDATED]: {
      state: DeFiPositionLifecycleState.LIQUIDATED,
      displayName: "Liquidated",
      description: "Position was liquidated due to undercollateralization",
      isTerminal: true,
    },
  },
  transitions: [
    // From ACTIVE
    {
      from: DeFiPositionLifecycleState.ACTIVE,
      to: DeFiPositionLifecycleState.PAUSED,
      description: "Protocol pause or user lock on position",
    },
    {
      from: DeFiPositionLifecycleState.ACTIVE,
      to: DeFiPositionLifecycleState.LIQUIDATION_RISK,
      description: "Health factor dropped below safe threshold",
    },
    {
      from: DeFiPositionLifecycleState.ACTIVE,
      to: DeFiPositionLifecycleState.CLOSED,
      description: "User withdrew collateral and closed position",
    },

    // From PAUSED
    {
      from: DeFiPositionLifecycleState.PAUSED,
      to: DeFiPositionLifecycleState.ACTIVE,
      description: "Resume position after pause lifted",
    },
    {
      from: DeFiPositionLifecycleState.PAUSED,
      to: DeFiPositionLifecycleState.CLOSED,
      description: "Close paused position during emergency exit",
    },

    // From LIQUIDATION_RISK
    {
      from: DeFiPositionLifecycleState.LIQUIDATION_RISK,
      to: DeFiPositionLifecycleState.ACTIVE,
      description: "Collateral added or debt repaid, restoring safety margin",
    },
    {
      from: DeFiPositionLifecycleState.LIQUIDATION_RISK,
      to: DeFiPositionLifecycleState.LIQUIDATED,
      description: "Liquidation executed by protocol keeper",
    },
    {
      from: DeFiPositionLifecycleState.LIQUIDATION_RISK,
      to: DeFiPositionLifecycleState.CLOSED,
      description: "Full debt settled and remaining balance withdrawn",
    },
  ],
};

export const DeFiPositionStateMachine = new DeterministicStateMachine<DeFiPositionLifecycleState>(
  DEFI_POSITION_STATE_MACHINE_DEF,
);

// ============================================================================
// 4. USER ACCOUNT LIFECYCLE
// ============================================================================

export enum UserLifecycleState {
  PENDING_VERIFICATION = "pending_verification",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  LOCKED = "locked",
  DEACTIVATED = "deactivated",
  ARCHIVED = "archived",
}

export const USER_STATE_MACHINE_DEF: StateMachineDefinition<UserLifecycleState> = {
  name: "User",
  initialState: UserLifecycleState.PENDING_VERIFICATION,
  states: {
    [UserLifecycleState.PENDING_VERIFICATION]: {
      state: UserLifecycleState.PENDING_VERIFICATION,
      displayName: "Pending Verification",
      description: "Account created, awaiting email verification or identity confirmation",
      isTerminal: false,
    },
    [UserLifecycleState.ACTIVE]: {
      state: UserLifecycleState.ACTIVE,
      displayName: "Active",
      description: "Account is in good standing and fully verified",
      isTerminal: false,
    },
    [UserLifecycleState.SUSPENDED]: {
      state: UserLifecycleState.SUSPENDED,
      displayName: "Suspended",
      description: "Account temporarily suspended for compliance, policy or risk reasons",
      isTerminal: false,
      isLocked: true,
    },
    [UserLifecycleState.LOCKED]: {
      state: UserLifecycleState.LOCKED,
      displayName: "Locked",
      description: "Security lockout due to failed logins or rate-limiting",
      isTerminal: false,
      isLocked: true,
    },
    [UserLifecycleState.DEACTIVATED]: {
      state: UserLifecycleState.DEACTIVATED,
      displayName: "Deactivated",
      description: "Account voluntarily deactivated by user",
      isTerminal: false,
      isLocked: true,
    },
    [UserLifecycleState.ARCHIVED]: {
      state: UserLifecycleState.ARCHIVED,
      displayName: "Archived",
      description: "Account permanently erased or closed",
      isTerminal: true,
      isLocked: true,
    },
  },
  transitions: [
    // From PENDING_VERIFICATION
    {
      from: UserLifecycleState.PENDING_VERIFICATION,
      to: UserLifecycleState.ACTIVE,
      description: "Email or wallet verification completed",
    },
    {
      from: UserLifecycleState.PENDING_VERIFICATION,
      to: UserLifecycleState.SUSPENDED,
      description: "Flagged during signup screening",
    },
    {
      from: UserLifecycleState.PENDING_VERIFICATION,
      to: UserLifecycleState.DEACTIVATED,
      description: "Cancelled prior to verification",
    },
    {
      from: UserLifecycleState.PENDING_VERIFICATION,
      to: UserLifecycleState.ARCHIVED,
      description: "Erased or timed out unverified account",
    },

    // From ACTIVE
    {
      from: UserLifecycleState.ACTIVE,
      to: UserLifecycleState.SUSPENDED,
      description: "Administrative or policy suspension",
    },
    {
      from: UserLifecycleState.ACTIVE,
      to: UserLifecycleState.LOCKED,
      description: "Security lockout",
    },
    {
      from: UserLifecycleState.ACTIVE,
      to: UserLifecycleState.DEACTIVATED,
      description: "Voluntary user deactivation",
    },
    {
      from: UserLifecycleState.ACTIVE,
      to: UserLifecycleState.ARCHIVED,
      description: "Account erasure / GDPR deletion",
    },

    // From SUSPENDED
    {
      from: UserLifecycleState.SUSPENDED,
      to: UserLifecycleState.ACTIVE,
      description: "Suspension lifted following review",
    },
    {
      from: UserLifecycleState.SUSPENDED,
      to: UserLifecycleState.ARCHIVED,
      description: "Permanent account termination",
    },

    // From LOCKED
    {
      from: UserLifecycleState.LOCKED,
      to: UserLifecycleState.ACTIVE,
      description: "Security lockout cleared via MFA / reset",
    },
    {
      from: UserLifecycleState.LOCKED,
      to: UserLifecycleState.SUSPENDED,
      description: "Escalated to suspension",
    },
    {
      from: UserLifecycleState.LOCKED,
      to: UserLifecycleState.ARCHIVED,
      description: "Locked account archived",
    },

    // From DEACTIVATED
    {
      from: UserLifecycleState.DEACTIVATED,
      to: UserLifecycleState.ACTIVE,
      description: "User reactivated their account",
    },
    {
      from: UserLifecycleState.DEACTIVATED,
      to: UserLifecycleState.ARCHIVED,
      description: "Deactivated account expired / purged",
    },
  ],
};

export const UserStateMachine = new DeterministicStateMachine<UserLifecycleState>(
  USER_STATE_MACHINE_DEF,
);

// ============================================================================
// 5. INVITATION LIFECYCLE
// ============================================================================

export enum InvitationLifecycleState {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  REVOKED = "REVOKED",
  EXPIRED = "EXPIRED",
}

export const INVITATION_STATE_MACHINE_DEF: StateMachineDefinition<InvitationLifecycleState> = {
  name: "Invitation",
  initialState: InvitationLifecycleState.PENDING,
  states: {
    [InvitationLifecycleState.PENDING]: {
      state: InvitationLifecycleState.PENDING,
      displayName: "Pending",
      description: "Invitation sent, awaiting acceptance",
      isTerminal: false,
    },
    [InvitationLifecycleState.ACCEPTED]: {
      state: InvitationLifecycleState.ACCEPTED,
      displayName: "Accepted",
      description: "Invitation accepted by invitee",
      isTerminal: true,
    },
    [InvitationLifecycleState.REVOKED]: {
      state: InvitationLifecycleState.REVOKED,
      displayName: "Revoked",
      description: "Invitation revoked by inviter or admin",
      isTerminal: true,
    },
    [InvitationLifecycleState.EXPIRED]: {
      state: InvitationLifecycleState.EXPIRED,
      displayName: "Expired",
      description: "Invitation validity period elapsed",
      isTerminal: true,
    },
  },
  transitions: [
    {
      from: InvitationLifecycleState.PENDING,
      to: InvitationLifecycleState.ACCEPTED,
      description: "Invitee accepted the invitation token",
    },
    {
      from: InvitationLifecycleState.PENDING,
      to: InvitationLifecycleState.REVOKED,
      description: "Inviter or admin revoked invitation",
    },
    {
      from: InvitationLifecycleState.PENDING,
      to: InvitationLifecycleState.EXPIRED,
      description: "Invitation reached expiration timestamp",
    },
  ],
};

export const InvitationStateMachine = new DeterministicStateMachine<InvitationLifecycleState>(
  INVITATION_STATE_MACHINE_DEF,
);

// ============================================================================
// 6. PAYMENT OPERATION LIFECYCLE
// ============================================================================

export enum PaymentOperationLifecycleState {
  CREATING = "CREATING",
  CREATED = "CREATED",
  SIGNED = "SIGNED",
  SUBMITTING = "SUBMITTING",
  SUBMITTED = "SUBMITTED",
  RECOVERY_REQUIRED = "RECOVERY_REQUIRED",
}

export const PAYMENT_OPERATION_STATE_MACHINE_DEF: StateMachineDefinition<PaymentOperationLifecycleState> = {
  name: "PaymentOperation",
  initialState: PaymentOperationLifecycleState.CREATING,
  states: {
    [PaymentOperationLifecycleState.CREATING]: {
      state: PaymentOperationLifecycleState.CREATING,
      displayName: "Creating",
      description: "Payment operation record being initialized",
      isTerminal: false,
    },
    [PaymentOperationLifecycleState.CREATED]: {
      state: PaymentOperationLifecycleState.CREATED,
      displayName: "Created",
      description: "Payment payload created and ready for signature",
      isTerminal: false,
    },
    [PaymentOperationLifecycleState.SIGNED]: {
      state: PaymentOperationLifecycleState.SIGNED,
      displayName: "Signed",
      description: "Payment transaction cryptographically signed",
      isTerminal: false,
    },
    [PaymentOperationLifecycleState.SUBMITTING]: {
      state: PaymentOperationLifecycleState.SUBMITTING,
      displayName: "Submitting",
      description: "Payment is actively being broadcasted to processor or network",
      isTerminal: false,
    },
    [PaymentOperationLifecycleState.SUBMITTED]: {
      state: PaymentOperationLifecycleState.SUBMITTED,
      displayName: "Submitted",
      description: "Payment successfully submitted and confirmed",
      isTerminal: true,
    },
    [PaymentOperationLifecycleState.RECOVERY_REQUIRED]: {
      state: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      displayName: "Recovery Required",
      description: "Operation failed or ambiguous; operator / retry intervention required",
      isTerminal: false,
    },
  },
  transitions: [
    // Forward progression
    {
      from: PaymentOperationLifecycleState.CREATING,
      to: PaymentOperationLifecycleState.CREATED,
      description: "Payment record created",
    },
    {
      from: PaymentOperationLifecycleState.CREATING,
      to: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      description: "Failed during creation",
    },

    {
      from: PaymentOperationLifecycleState.CREATED,
      to: PaymentOperationLifecycleState.SIGNED,
      description: "Payment signed",
    },
    {
      from: PaymentOperationLifecycleState.CREATED,
      to: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      description: "Signing failed or aborted",
    },

    {
      from: PaymentOperationLifecycleState.SIGNED,
      to: PaymentOperationLifecycleState.SUBMITTING,
      description: "Initiating submission",
    },
    {
      from: PaymentOperationLifecycleState.SIGNED,
      to: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      description: "Pre-submission failure",
    },

    {
      from: PaymentOperationLifecycleState.SUBMITTING,
      to: PaymentOperationLifecycleState.SUBMITTED,
      description: "Submission successful",
    },
    {
      from: PaymentOperationLifecycleState.SUBMITTING,
      to: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      description: "Network timeout or ambiguous failure",
    },

    // Recovery transitions
    {
      from: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      to: PaymentOperationLifecycleState.CREATED,
      description: "Retry signing from created state",
    },
    {
      from: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      to: PaymentOperationLifecycleState.SIGNED,
      description: "Resume from signed state",
    },
    {
      from: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      to: PaymentOperationLifecycleState.SUBMITTING,
      description: "Retry submission",
    },
    {
      from: PaymentOperationLifecycleState.RECOVERY_REQUIRED,
      to: PaymentOperationLifecycleState.SUBMITTED,
      description: "Reconciled as completed after out-of-band verification",
    },
  ],
};

export const PaymentOperationStateMachine = new DeterministicStateMachine<PaymentOperationLifecycleState>(
  PAYMENT_OPERATION_STATE_MACHINE_DEF,
);

// ============================================================================
// STATE DERIVATION HELPERS (Unified Model for API & UI)
// ============================================================================

/**
 * Derives user lifecycle state from user record and backward-compatible boolean flags.
 */
export function deriveUserLifecycleState(user: {
  isActive?: boolean;
  emailVerified?: boolean;
  lifecycleState?: UserLifecycleState | string | null;
  deletedAt?: Date | null;
}): UserLifecycleState {
  if (user.lifecycleState) {
    const val = user.lifecycleState.toLowerCase() as UserLifecycleState;
    if (Object.values(UserLifecycleState).includes(val)) {
      return val;
    }
  }
  if (user.deletedAt) {
    return UserLifecycleState.ARCHIVED;
  }
  if (user.isActive === false) {
    return user.emailVerified
      ? UserLifecycleState.SUSPENDED
      : UserLifecycleState.PENDING_VERIFICATION;
  }
  return UserLifecycleState.ACTIVE;
}

/**
 * Derives portfolio lifecycle state from portfolio entity and flags.
 */
export function derivePortfolioLifecycleState(portfolio: {
  status?: string | PortfolioLifecycleState;
  deletedAt?: Date | null;
}): PortfolioLifecycleState {
  if (portfolio.deletedAt || portfolio.status === "archived" || portfolio.status === PortfolioLifecycleState.ARCHIVED) {
    return PortfolioLifecycleState.ARCHIVED;
  }
  const s = portfolio.status as PortfolioLifecycleState;
  if (Object.values(PortfolioLifecycleState).includes(s)) {
    return s;
  }
  return PortfolioLifecycleState.ACTIVE;
}
