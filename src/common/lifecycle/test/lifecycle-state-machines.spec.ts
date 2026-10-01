import {
  PortfolioLifecycleState,
  PortfolioStateMachine,
  derivePortfolioLifecycleState,
  TransactionLifecycleState,
  TransactionStateMachine,
  DeFiPositionLifecycleState,
  DeFiPositionStateMachine,
  UserLifecycleState,
  UserStateMachine,
  deriveUserLifecycleState,
  InvitationLifecycleState,
  InvitationStateMachine,
  PaymentOperationLifecycleState,
  PaymentOperationStateMachine,
} from "../record-state-machines";
import { InvalidStateTransitionException } from "../invalid-state-transition.exception";
import { LifecycleService } from "../lifecycle.service";
import { Portfolio, PortfolioStatus } from "src/investment/portfolio/entities/portfolio.entity";
import { User, UserStatus, KycStatus } from "src/core/user/entities/user.entity";
import { Role } from "src/common/guard/roles.enum";
import { LifecycleEventType } from "src/notifications/events/lifecycle-events";

describe("Deterministic Lifecycle State Machines (#25)", () => {
  describe("PortfolioStateMachine", () => {
    const validTransitions: [PortfolioLifecycleState, PortfolioLifecycleState][] = [
      [PortfolioLifecycleState.DRAFT, PortfolioLifecycleState.ACTIVE],
      [PortfolioLifecycleState.DRAFT, PortfolioLifecycleState.ARCHIVED],
      [PortfolioLifecycleState.ACTIVE, PortfolioLifecycleState.REBALANCING],
      [PortfolioLifecycleState.ACTIVE, PortfolioLifecycleState.PAUSED],
      [PortfolioLifecycleState.ACTIVE, PortfolioLifecycleState.FROZEN],
      [PortfolioLifecycleState.ACTIVE, PortfolioLifecycleState.ARCHIVED],
      [PortfolioLifecycleState.REBALANCING, PortfolioLifecycleState.ACTIVE],
      [PortfolioLifecycleState.REBALANCING, PortfolioLifecycleState.PAUSED],
      [PortfolioLifecycleState.REBALANCING, PortfolioLifecycleState.FROZEN],
      [PortfolioLifecycleState.PAUSED, PortfolioLifecycleState.ACTIVE],
      [PortfolioLifecycleState.PAUSED, PortfolioLifecycleState.ARCHIVED],
      [PortfolioLifecycleState.FROZEN, PortfolioLifecycleState.ACTIVE],
      [PortfolioLifecycleState.FROZEN, PortfolioLifecycleState.ARCHIVED],
      // Idempotent self-transitions
      [PortfolioLifecycleState.ACTIVE, PortfolioLifecycleState.ACTIVE],
      [PortfolioLifecycleState.PAUSED, PortfolioLifecycleState.PAUSED],
    ];

    test.each(validTransitions)(
      "allows valid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await PortfolioStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(true);

        const nextState = await PortfolioStateMachine.transition(fromState, toState);
        expect(nextState).toBe(toState);
      },
    );

    const invalidTransitions: [PortfolioLifecycleState, PortfolioLifecycleState][] = [
      [PortfolioLifecycleState.ARCHIVED, PortfolioLifecycleState.ACTIVE],
      [PortfolioLifecycleState.ARCHIVED, PortfolioLifecycleState.DRAFT],
      [PortfolioLifecycleState.ARCHIVED, PortfolioLifecycleState.REBALANCING],
      [PortfolioLifecycleState.DRAFT, PortfolioLifecycleState.REBALANCING],
      [PortfolioLifecycleState.DRAFT, PortfolioLifecycleState.PAUSED],
      [PortfolioLifecycleState.DRAFT, PortfolioLifecycleState.FROZEN],
      [PortfolioLifecycleState.REBALANCING, PortfolioLifecycleState.DRAFT],
      [PortfolioLifecycleState.PAUSED, PortfolioLifecycleState.REBALANCING],
      [PortfolioLifecycleState.PAUSED, PortfolioLifecycleState.DRAFT],
      [PortfolioLifecycleState.FROZEN, PortfolioLifecycleState.REBALANCING],
      [PortfolioLifecycleState.FROZEN, PortfolioLifecycleState.DRAFT],
    ];

    test.each(invalidTransitions)(
      "rejects invalid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await PortfolioStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(false);

        await expect(
          PortfolioStateMachine.assertCanTransition(fromState, toState, undefined, {
            resourceId: "port-123",
            resourceType: "portfolio",
          }),
        ).rejects.toThrow(InvalidStateTransitionException);

        try {
          await PortfolioStateMachine.assertCanTransition(fromState, toState, undefined, {
            resourceId: "port-123",
            resourceType: "portfolio",
          });
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidStateTransitionException);
          const exc = error as InvalidStateTransitionException;
          expect(exc.getStatus()).toBe(400);
          expect(exc.currentState).toBe(fromState);
          expect(exc.attemptedState).toBe(toState);
          expect(exc.resourceId).toBe("port-123");
          expect(exc.resourceType).toBe("portfolio");
          expect(exc.stateMachineName).toBe("Portfolio");
        }
      },
    );

    it("evaluates transition diagnostics properly", async () => {
      const evaluation = await PortfolioStateMachine.evaluateTransition(
        PortfolioLifecycleState.ARCHIVED,
        PortfolioLifecycleState.ACTIVE,
      );
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.isTerminal).toBe(true);
      expect(evaluation.allowedTransitions).toEqual([]);
    });

    it("derives portfolio state model for UI/API consistency", () => {
      const activeModel = PortfolioStateMachine.deriveStateModel(PortfolioLifecycleState.ACTIVE);
      expect(activeModel.state).toBe(PortfolioLifecycleState.ACTIVE);
      expect(activeModel.isTerminal).toBe(false);
      expect(activeModel.allowedTransitions).toContain(PortfolioLifecycleState.REBALANCING);
      expect(activeModel.allowedTransitions).toContain(PortfolioLifecycleState.PAUSED);
      expect(activeModel.allowedTransitions).toContain(PortfolioLifecycleState.FROZEN);
      expect(activeModel.allowedTransitions).toContain(PortfolioLifecycleState.ARCHIVED);

      const archivedModel = PortfolioStateMachine.deriveStateModel(PortfolioLifecycleState.ARCHIVED);
      expect(archivedModel.isTerminal).toBe(true);
      expect(archivedModel.allowedTransitions).toEqual([]);
    });

    it("correctly derives state from legacy portfolio records", () => {
      const activePortfolio = {
        status: PortfolioStatus.ACTIVE,
        deletedAt: null,
      } as unknown as Portfolio;
      expect(derivePortfolioLifecycleState(activePortfolio)).toBe(PortfolioLifecycleState.ACTIVE);

      const softDeletedPortfolio = {
        status: PortfolioStatus.ACTIVE,
        deletedAt: new Date(),
      } as unknown as Portfolio;
      expect(derivePortfolioLifecycleState(softDeletedPortfolio)).toBe(PortfolioLifecycleState.ARCHIVED);

      const draftPortfolio = {
        status: PortfolioStatus.DRAFT,
        deletedAt: null,
      } as unknown as Portfolio;
      expect(derivePortfolioLifecycleState(draftPortfolio)).toBe(PortfolioLifecycleState.DRAFT);
    });
  });

  describe("TransactionStateMachine", () => {
    const validTransitions: [TransactionLifecycleState, TransactionLifecycleState][] = [
      [TransactionLifecycleState.PENDING, TransactionLifecycleState.SUBMITTED],
      [TransactionLifecycleState.PENDING, TransactionLifecycleState.CANCELLED],
      [TransactionLifecycleState.PENDING, TransactionLifecycleState.FAILED],
      [TransactionLifecycleState.SUBMITTED, TransactionLifecycleState.CONFIRMED],
      [TransactionLifecycleState.SUBMITTED, TransactionLifecycleState.FAILED],
      [TransactionLifecycleState.SUBMITTED, TransactionLifecycleState.TIMED_OUT],
      [TransactionLifecycleState.SUBMITTED, TransactionLifecycleState.REVERTED],
    ];

    test.each(validTransitions)(
      "allows valid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await TransactionStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(true);
      },
    );

    const invalidTransitions: [TransactionLifecycleState, TransactionLifecycleState][] = [
      [TransactionLifecycleState.CONFIRMED, TransactionLifecycleState.PENDING],
      [TransactionLifecycleState.CONFIRMED, TransactionLifecycleState.SUBMITTED],
      [TransactionLifecycleState.CONFIRMED, TransactionLifecycleState.REVERTED],
      [TransactionLifecycleState.FAILED, TransactionLifecycleState.CONFIRMED],
      [TransactionLifecycleState.CANCELLED, TransactionLifecycleState.SUBMITTED],
      [TransactionLifecycleState.TIMED_OUT, TransactionLifecycleState.CONFIRMED],
      [TransactionLifecycleState.REVERTED, TransactionLifecycleState.CONFIRMED],
    ];

    test.each(invalidTransitions)(
      "rejects invalid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await TransactionStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(false);

        await expect(
          TransactionStateMachine.assertCanTransition(fromState, toState),
        ).rejects.toThrow(InvalidStateTransitionException);
      },
    );
  });

  describe("DeFiPositionStateMachine", () => {
    const validTransitions: [DeFiPositionLifecycleState, DeFiPositionLifecycleState][] = [
      [DeFiPositionLifecycleState.ACTIVE, DeFiPositionLifecycleState.PAUSED],
      [DeFiPositionLifecycleState.ACTIVE, DeFiPositionLifecycleState.LIQUIDATION_RISK],
      [DeFiPositionLifecycleState.ACTIVE, DeFiPositionLifecycleState.CLOSED],
      [DeFiPositionLifecycleState.PAUSED, DeFiPositionLifecycleState.ACTIVE],
      [DeFiPositionLifecycleState.PAUSED, DeFiPositionLifecycleState.CLOSED],
      [DeFiPositionLifecycleState.LIQUIDATION_RISK, DeFiPositionLifecycleState.ACTIVE],
      [DeFiPositionLifecycleState.LIQUIDATION_RISK, DeFiPositionLifecycleState.LIQUIDATED],
      [DeFiPositionLifecycleState.LIQUIDATION_RISK, DeFiPositionLifecycleState.CLOSED],
    ];

    test.each(validTransitions)(
      "allows valid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await DeFiPositionStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(true);
      },
    );

    const invalidTransitions: [DeFiPositionLifecycleState, DeFiPositionLifecycleState][] = [
      [DeFiPositionLifecycleState.CLOSED, DeFiPositionLifecycleState.ACTIVE],
      [DeFiPositionLifecycleState.CLOSED, DeFiPositionLifecycleState.PAUSED],
      [DeFiPositionLifecycleState.CLOSED, DeFiPositionLifecycleState.LIQUIDATION_RISK],
      [DeFiPositionLifecycleState.LIQUIDATED, DeFiPositionLifecycleState.ACTIVE],
      [DeFiPositionLifecycleState.LIQUIDATED, DeFiPositionLifecycleState.CLOSED],
      [DeFiPositionLifecycleState.PAUSED, DeFiPositionLifecycleState.LIQUIDATED],
    ];

    test.each(invalidTransitions)(
      "rejects invalid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await DeFiPositionStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(false);

        await expect(
          DeFiPositionStateMachine.assertCanTransition(fromState, toState),
        ).rejects.toThrow(InvalidStateTransitionException);
      },
    );
  });

  describe("UserStateMachine", () => {
    const validTransitions: [UserLifecycleState, UserLifecycleState][] = [
      [UserLifecycleState.PENDING_VERIFICATION, UserLifecycleState.ACTIVE],
      [UserLifecycleState.PENDING_VERIFICATION, UserLifecycleState.SUSPENDED],
      [UserLifecycleState.PENDING_VERIFICATION, UserLifecycleState.DEACTIVATED],
      [UserLifecycleState.PENDING_VERIFICATION, UserLifecycleState.ARCHIVED],
      [UserLifecycleState.ACTIVE, UserLifecycleState.SUSPENDED],
      [UserLifecycleState.ACTIVE, UserLifecycleState.LOCKED],
      [UserLifecycleState.ACTIVE, UserLifecycleState.DEACTIVATED],
      [UserLifecycleState.ACTIVE, UserLifecycleState.ARCHIVED],
      [UserLifecycleState.SUSPENDED, UserLifecycleState.ACTIVE],
      [UserLifecycleState.SUSPENDED, UserLifecycleState.ARCHIVED],
      [UserLifecycleState.LOCKED, UserLifecycleState.ACTIVE],
      [UserLifecycleState.LOCKED, UserLifecycleState.SUSPENDED],
      [UserLifecycleState.LOCKED, UserLifecycleState.ARCHIVED],
      [UserLifecycleState.DEACTIVATED, UserLifecycleState.ACTIVE],
      [UserLifecycleState.DEACTIVATED, UserLifecycleState.ARCHIVED],
    ];

    test.each(validTransitions)(
      "allows valid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await UserStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(true);
      },
    );

    const invalidTransitions: [UserLifecycleState, UserLifecycleState][] = [
      [UserLifecycleState.ARCHIVED, UserLifecycleState.ACTIVE],
      [UserLifecycleState.ARCHIVED, UserLifecycleState.PENDING_VERIFICATION],
      [UserLifecycleState.ARCHIVED, UserLifecycleState.SUSPENDED],
      [UserLifecycleState.PENDING_VERIFICATION, UserLifecycleState.LOCKED],
      [UserLifecycleState.SUSPENDED, UserLifecycleState.DEACTIVATED],
      [UserLifecycleState.DEACTIVATED, UserLifecycleState.SUSPENDED],
      [UserLifecycleState.DEACTIVATED, UserLifecycleState.LOCKED],
    ];

    test.each(invalidTransitions)(
      "rejects invalid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await UserStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(false);

        await expect(
          UserStateMachine.assertCanTransition(fromState, toState),
        ).rejects.toThrow(InvalidStateTransitionException);
      },
    );

    it("correctly derives state from legacy user records", () => {
      const activeUser = {
        isActive: true,
        emailVerified: true,
        kycStatus: KycStatus.VERIFIED,
      } as unknown as User;
      expect(deriveUserLifecycleState(activeUser)).toBe(UserLifecycleState.ACTIVE);

      const unverifiedUser = {
        isActive: false,
        emailVerified: false,
        kycStatus: KycStatus.UNVERIFIED,
      } as unknown as User;
      expect(deriveUserLifecycleState(unverifiedUser)).toBe(UserLifecycleState.PENDING_VERIFICATION);

      const explicitSuspendedUser = {
        lifecycleState: UserStatus.SUSPENDED,
        isActive: false,
      } as unknown as User;
      expect(deriveUserLifecycleState(explicitSuspendedUser)).toBe(UserLifecycleState.SUSPENDED);
    });
  });

  describe("InvitationStateMachine", () => {
    const validTransitions: [InvitationLifecycleState, InvitationLifecycleState][] = [
      [InvitationLifecycleState.PENDING, InvitationLifecycleState.ACCEPTED],
      [InvitationLifecycleState.PENDING, InvitationLifecycleState.REVOKED],
      [InvitationLifecycleState.PENDING, InvitationLifecycleState.EXPIRED],
    ];

    test.each(validTransitions)(
      "allows valid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await InvitationStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(true);
      },
    );

    const invalidTransitions: [InvitationLifecycleState, InvitationLifecycleState][] = [
      [InvitationLifecycleState.ACCEPTED, InvitationLifecycleState.PENDING],
      [InvitationLifecycleState.ACCEPTED, InvitationLifecycleState.REVOKED],
      [InvitationLifecycleState.REVOKED, InvitationLifecycleState.ACCEPTED],
      [InvitationLifecycleState.REVOKED, InvitationLifecycleState.PENDING],
      [InvitationLifecycleState.EXPIRED, InvitationLifecycleState.ACCEPTED],
      [InvitationLifecycleState.EXPIRED, InvitationLifecycleState.PENDING],
    ];

    test.each(invalidTransitions)(
      "rejects invalid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await InvitationStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(false);

        await expect(
          InvitationStateMachine.assertCanTransition(fromState, toState),
        ).rejects.toThrow(InvalidStateTransitionException);
      },
    );
  });

  describe("PaymentOperationStateMachine", () => {
    const validTransitions: [PaymentOperationLifecycleState, PaymentOperationLifecycleState][] = [
      [PaymentOperationLifecycleState.CREATING, PaymentOperationLifecycleState.CREATED],
      [PaymentOperationLifecycleState.CREATED, PaymentOperationLifecycleState.SIGNED],
      [PaymentOperationLifecycleState.SIGNED, PaymentOperationLifecycleState.SUBMITTING],
      [PaymentOperationLifecycleState.SUBMITTING, PaymentOperationLifecycleState.SUBMITTED],
      [PaymentOperationLifecycleState.SUBMITTING, PaymentOperationLifecycleState.RECOVERY_REQUIRED],
      [PaymentOperationLifecycleState.RECOVERY_REQUIRED, PaymentOperationLifecycleState.SUBMITTING],
      [PaymentOperationLifecycleState.RECOVERY_REQUIRED, PaymentOperationLifecycleState.CREATED],
    ];

    test.each(validTransitions)(
      "allows valid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await PaymentOperationStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(true);
      },
    );

    const invalidTransitions: [PaymentOperationLifecycleState, PaymentOperationLifecycleState][] = [
      [PaymentOperationLifecycleState.SUBMITTED, PaymentOperationLifecycleState.CREATING],
      [PaymentOperationLifecycleState.SUBMITTED, PaymentOperationLifecycleState.SIGNED],
      [PaymentOperationLifecycleState.CREATED, PaymentOperationLifecycleState.SUBMITTED],
      [PaymentOperationLifecycleState.SIGNED, PaymentOperationLifecycleState.CREATING],
      [PaymentOperationLifecycleState.CREATING, PaymentOperationLifecycleState.SUBMITTED],
    ];

    test.each(invalidTransitions)(
      "rejects invalid transition from %s to %s",
      async (fromState, toState) => {
        const canTransition = await PaymentOperationStateMachine.canTransition(fromState, toState);
        expect(canTransition).toBe(false);

        await expect(
          PaymentOperationStateMachine.assertCanTransition(fromState, toState),
        ).rejects.toThrow(InvalidStateTransitionException);
      },
    );
  });

  describe("LifecycleService Integration", () => {
    let lifecycleService: LifecycleService;
    let mockAuditService: any;
    let mockEventEmitter: any;

    beforeEach(() => {
      mockAuditService = {
        recordSensitiveAction: jest.fn().mockResolvedValue(undefined),
      };
      mockEventEmitter = {
        emit: jest.fn(),
      };
      lifecycleService = new LifecycleService(mockAuditService, mockEventEmitter);
    });

    it("transitions portfolio and creates audit record and model", async () => {
      const result = await lifecycleService.transitionPortfolio(
        "port-1",
        PortfolioLifecycleState.ACTIVE,
        PortfolioLifecycleState.REBALANCING,
        { actorId: "user-123", reason: "Automatic rebalance triggered" },
        { name: "My Portfolio", status: PortfolioStatus.ACTIVE },
      );

      expect(result.state).toBe(PortfolioLifecycleState.REBALANCING);
      expect(result.model.state).toBe(PortfolioLifecycleState.REBALANCING);
      expect(result.model.isTerminal).toBe(false);
      expect(mockAuditService.recordSensitiveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: "portfolio",
          resourceId: "port-1",
          reason: "Automatic rebalance triggered",
        }),
      );
    });

    it("emits critical lifecycle event when portfolio is frozen", async () => {
      await lifecycleService.transitionPortfolio(
        "port-1",
        PortfolioLifecycleState.ACTIVE,
        PortfolioLifecycleState.FROZEN,
        { userId: "user-999", reason: "Circuit breaker tripped" },
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        LifecycleEventType.CIRCUIT_BREAKER_TRIPPED,
        expect.objectContaining({
          userId: "user-999",
          referenceId: "port-1",
        }),
      );
    });

    it("rejects invalid transitions through lifecycle service and does not execute side effects", async () => {
      await expect(
        lifecycleService.transitionPortfolio(
          "port-1",
          PortfolioLifecycleState.ARCHIVED,
          PortfolioLifecycleState.ACTIVE,
        ),
      ).rejects.toThrow(InvalidStateTransitionException);

      expect(mockAuditService.recordSensitiveAction).not.toHaveBeenCalled();
    });
  });
});
