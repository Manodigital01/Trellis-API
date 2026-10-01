import { Injectable, Logger, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  PortfolioLifecycleState,
  PortfolioStateMachine,
  TransactionLifecycleState,
  TransactionStateMachine,
  DeFiPositionLifecycleState,
  DeFiPositionStateMachine,
  UserLifecycleState,
  UserStateMachine,
  InvitationLifecycleState,
  InvitationStateMachine,
  PaymentOperationLifecycleState,
  PaymentOperationStateMachine,
} from "./record-state-machines";
import {
  TransitionContext,
  StateDerivedModel,
  TransitionEvaluationResult,
} from "./state-machine.interface";
import { SensitiveActionAuditService } from "src/infrastructure/audit/sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "src/infrastructure/audit/sensitive-actions/sensitive-action.enum";
import {
  AuditActorType,
  SensitiveActionStatus,
} from "src/infrastructure/audit/entities/sensitive-action-event.entity";
import { CriticalLifecycleEvent, LifecycleEventType } from "src/notifications/events/lifecycle-events";

export interface LifecycleTransitionRequest<TState extends string> {
  resourceType: "portfolio" | "transaction" | "defi_position" | "user" | "invitation" | "payment_operation";
  resourceId: string;
  currentState: TState;
  targetState: TState;
  context?: TransitionContext;
  beforeSnapshot?: Record<string, any>;
  afterSnapshot?: Record<string, any>;
}

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @Optional() private readonly auditService?: SensitiveActionAuditService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  // --------------------------------------------------------------------------
  // STATE MACHINE REGISTRY ACCESS
  // --------------------------------------------------------------------------

  public get portfolio(): typeof PortfolioStateMachine {
    return PortfolioStateMachine;
  }

  public get transaction(): typeof TransactionStateMachine {
    return TransactionStateMachine;
  }

  public get defiPosition(): typeof DeFiPositionStateMachine {
    return DeFiPositionStateMachine;
  }

  public get user(): typeof UserStateMachine {
    return UserStateMachine;
  }

  public get invitation(): typeof InvitationStateMachine {
    return InvitationStateMachine;
  }

  public get paymentOperation(): typeof PaymentOperationStateMachine {
    return PaymentOperationStateMachine;
  }

  // --------------------------------------------------------------------------
  // UNIFIED TRANSITION EVALUATION & EXECUTION
  // --------------------------------------------------------------------------

  /**
   * Evaluates if a transition is permitted.
   */
  async evaluatePortfolioTransition(
    fromState: PortfolioLifecycleState,
    toState: PortfolioLifecycleState,
    context?: TransitionContext,
  ): Promise<TransitionEvaluationResult<PortfolioLifecycleState>> {
    return PortfolioStateMachine.evaluateTransition(fromState, toState, context);
  }

  /**
   * Executes a guarded portfolio state transition with durable audit trail and lifecycle events.
   */
  async transitionPortfolio(
    portfolioId: string,
    currentState: PortfolioLifecycleState,
    targetState: PortfolioLifecycleState,
    context?: TransitionContext,
    beforeSnapshot?: Record<string, any>,
  ): Promise<{ state: PortfolioLifecycleState; model: StateDerivedModel<PortfolioLifecycleState> }> {
    await PortfolioStateMachine.assertCanTransition(currentState, targetState, context, {
      resourceId: portfolioId,
      resourceType: "portfolio",
    });

    const nextState = await PortfolioStateMachine.transition(currentState, targetState, context, {
      resourceId: portfolioId,
      resourceType: "portfolio",
    });

    // Record sensitive action audit event if state change affects funds/operations
    if (this.auditService) {
      await this.auditService.recordSensitiveAction({
        action: SensitiveAction.PORTFOLIO_RECORD_CHANGED,
        actorId: context?.actorId ?? "system",
        actorType: context?.actorId ? AuditActorType.USER : AuditActorType.SYSTEM,
        actorRole: context?.actorRole,
        resourceType: "portfolio",
        resourceId: portfolioId,
        reason: context?.reason || `Portfolio lifecycle transition: ${currentState} -> ${targetState}`,
        beforeState: { ...(beforeSnapshot || {}), lifecycleState: currentState },
        afterState: { ...(beforeSnapshot || {}), lifecycleState: targetState },
        status: SensitiveActionStatus.SUCCEEDED,
      }).catch((err) => {
        this.logger.warn(`Failed to write sensitive audit log for portfolio transition: ${err.message}`);
      });
    }

    // Emit lifecycle event for critical transitions
    if (this.eventEmitter && context?.userId) {
      if (targetState === PortfolioLifecycleState.FROZEN) {
        this.eventEmitter.emit(
          LifecycleEventType.CIRCUIT_BREAKER_TRIPPED,
          new CriticalLifecycleEvent({
            userId: context.userId,
            eventType: LifecycleEventType.CIRCUIT_BREAKER_TRIPPED,
            title: "Portfolio Frozen",
            message: `Portfolio ${portfolioId} has been frozen. Reason: ${context?.reason || "Risk guard triggered"}`,
            deepLink: `/portfolio/${portfolioId}`,
            deduplicationKey: `portfolio-frozen-${portfolioId}-${Date.now()}`,
            referenceId: portfolioId,
            referenceType: "portfolio",
          }),
        );
      }
    }

    return {
      state: nextState,
      model: PortfolioStateMachine.deriveStateModel(nextState),
    };
  }

  /**
   * Executes a guarded user lifecycle state transition.
   */
  async transitionUser(
    userId: string,
    currentState: UserLifecycleState,
    targetState: UserLifecycleState,
    context?: TransitionContext,
    beforeSnapshot?: Record<string, any>,
  ): Promise<{ state: UserLifecycleState; model: StateDerivedModel<UserLifecycleState> }> {
    await UserStateMachine.assertCanTransition(currentState, targetState, context, {
      resourceId: userId,
      resourceType: "user",
    });

    const nextState = await UserStateMachine.transition(currentState, targetState, context, {
      resourceId: userId,
      resourceType: "user",
    });

    if (this.auditService) {
      const action =
        targetState === UserLifecycleState.SUSPENDED
          ? SensitiveAction.USER_SUSPENDED
          : targetState === UserLifecycleState.ACTIVE
          ? SensitiveAction.USER_REACTIVATED
          : targetState === UserLifecycleState.ARCHIVED
          ? SensitiveAction.USER_DELETED
          : SensitiveAction.ROLE_ASSIGNED;

      await this.auditService.recordSensitiveAction({
        action,
        actorId: context?.actorId ?? userId,
        actorType: context?.actorRole ? AuditActorType.MAINTAINER : AuditActorType.USER,
        actorRole: context?.actorRole,
        resourceType: "user",
        resourceId: userId,
        reason: context?.reason || `User lifecycle transition: ${currentState} -> ${targetState}`,
        beforeState: { ...(beforeSnapshot || {}), lifecycleState: currentState },
        afterState: { ...(beforeSnapshot || {}), lifecycleState: targetState },
        status: SensitiveActionStatus.SUCCEEDED,
      }).catch((err) => {
        this.logger.warn(`Failed to write sensitive audit log for user transition: ${err.message}`);
      });
    }

    return {
      state: nextState,
      model: UserStateMachine.deriveStateModel(nextState),
    };
  }

  /**
   * Executes a guarded DeFi position state transition.
   */
  async transitionDeFiPosition(
    positionId: string,
    currentState: DeFiPositionLifecycleState,
    targetState: DeFiPositionLifecycleState,
    context?: TransitionContext,
    beforeSnapshot?: Record<string, any>,
  ): Promise<{ state: DeFiPositionLifecycleState; model: StateDerivedModel<DeFiPositionLifecycleState> }> {
    await DeFiPositionStateMachine.assertCanTransition(currentState, targetState, context, {
      resourceId: positionId,
      resourceType: "defi_position",
    });

    const nextState = await DeFiPositionStateMachine.transition(currentState, targetState, context, {
      resourceId: positionId,
      resourceType: "defi_position",
    });

    return {
      state: nextState,
      model: DeFiPositionStateMachine.deriveStateModel(nextState),
    };
  }

  /**
   * Executes a guarded transaction state transition.
   */
  async transitionTransaction(
    transactionId: string,
    currentState: TransactionLifecycleState,
    targetState: TransactionLifecycleState,
    context?: TransitionContext,
  ): Promise<{ state: TransactionLifecycleState; model: StateDerivedModel<TransactionLifecycleState> }> {
    await TransactionStateMachine.assertCanTransition(currentState, targetState, context, {
      resourceId: transactionId,
      resourceType: "transaction",
    });

    const nextState = await TransactionStateMachine.transition(currentState, targetState, context, {
      resourceId: transactionId,
      resourceType: "transaction",
    });

    return {
      state: nextState,
      model: TransactionStateMachine.deriveStateModel(nextState),
    };
  }
}
