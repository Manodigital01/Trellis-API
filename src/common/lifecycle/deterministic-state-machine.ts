import { Logger } from "@nestjs/common";
import {
  StateMachineDefinition,
  StateMetadata,
  TransitionContext,
  TransitionEvaluationResult,
  TransitionRule,
  StateDerivedModel,
} from "./state-machine.interface";
import { InvalidStateTransitionException } from "./invalid-state-transition.exception";

/**
 * Deterministic State Machine implementation.
 * 
 * Enforces explicit lifecycle states, guarded transitions, terminal state invariants,
 * and standard error responses across services, API contracts, and UI derivations.
 */
export class DeterministicStateMachine<
  TState extends string,
  TContext extends TransitionContext = TransitionContext,
> {
  private readonly logger: Logger;
  private readonly transitionIndex = new Map<TState, TransitionRule<TState, TContext>[]>();

  constructor(public readonly definition: StateMachineDefinition<TState, TContext>) {
    this.logger = new Logger(`StateMachine:${definition.name}`);
    this.buildIndex();
  }

  private buildIndex(): void {
    for (const state of Object.keys(this.definition.states) as TState[]) {
      this.transitionIndex.set(state, []);
    }

    for (const rule of this.definition.transitions) {
      const fromStates = Array.isArray(rule.from) ? rule.from : [rule.from];
      for (const fromState of fromStates) {
        if (!this.definition.states[fromState]) {
          throw new Error(
            `State machine "${this.definition.name}" definition error: 'from' state "${fromState}" is not declared in states.`,
          );
        }
        if (!this.definition.states[rule.to]) {
          throw new Error(
            `State machine "${this.definition.name}" definition error: 'to' state "${rule.to}" is not declared in states.`,
          );
        }

        const list = this.transitionIndex.get(fromState) ?? [];
        list.push(rule);
        this.transitionIndex.set(fromState, list);
      }
    }
  }

  public get name(): string {
    return this.definition.name;
  }

  public get initialState(): TState {
    return this.definition.initialState;
  }

  public getStates(): TState[] {
    return Object.keys(this.definition.states) as TState[];
  }

  public getStateMetadata(state: TState): StateMetadata<TState> | undefined {
    return this.definition.states[state];
  }

  public isTerminal(state: TState): boolean {
    return this.definition.states[state]?.isTerminal ?? false;
  }

  public isLocked(state: TState): boolean {
    return this.definition.states[state]?.isLocked ?? false;
  }

  /**
   * Returns list of valid destination states from a given current state.
   */
  public getAllowedTransitions(fromState: TState): TState[] {
    const rules = this.transitionIndex.get(fromState) || [];
    return [...new Set(rules.map((r) => r.to))];
  }

  /**
   * Evaluates whether a transition from `fromState` to `toState` is legally permitted.
   */
  public async evaluateTransition(
    fromState: TState,
    toState: TState,
    context?: TContext,
  ): Promise<TransitionEvaluationResult<TState>> {
    const allowedTransitions = this.getAllowedTransitions(fromState);
    const isTerminal = this.isTerminal(fromState);

    // If already in target state, idempotent transition is valid
    if (fromState === toState) {
      return {
        allowed: true,
        fromState,
        toState,
        allowedTransitions,
        isTerminal,
      };
    }

    // Check if current state is terminal
    if (isTerminal) {
      return {
        allowed: false,
        fromState,
        toState,
        reason: `State "${fromState}" is terminal and cannot transition to any other state`,
        allowedTransitions,
        isTerminal: true,
      };
    }

    const rules = (this.transitionIndex.get(fromState) || []).filter((r) => r.to === toState);
    if (rules.length === 0) {
      return {
        allowed: false,
        fromState,
        toState,
        reason: `No transition defined from "${fromState}" to "${toState}"`,
        allowedTransitions,
        isTerminal: false,
      };
    }

    // Evaluate guards if any
    for (const rule of rules) {
      if (rule.guard) {
        const guardResult = await rule.guard(context);
        if (guardResult === false) {
          return {
            allowed: false,
            fromState,
            toState,
            reason: `Transition guard rejected transition from "${fromState}" to "${toState}"`,
            allowedTransitions,
            isTerminal: false,
          };
        }
        if (typeof guardResult === "string") {
          return {
            allowed: false,
            fromState,
            toState,
            reason: guardResult,
            allowedTransitions,
            isTerminal: false,
          };
        }
      }
    }

    return {
      allowed: true,
      fromState,
      toState,
      allowedTransitions,
      isTerminal: false,
    };
  }

  /**
   * Synchronous check for transition validity (ignoring async guards).
   */
  public canTransition(fromState: TState, toState: TState): boolean {
    if (fromState === toState) return true;
    if (this.isTerminal(fromState)) return false;
    const rules = (this.transitionIndex.get(fromState) || []).filter((r) => r.to === toState);
    return rules.length > 0;
  }

  /**
   * Asserts that a transition is valid. Throws InvalidStateTransitionException if not.
   */
  public async assertCanTransition(
    fromState: TState,
    toState: TState,
    context?: TContext,
    metadata?: { resourceId?: string; resourceType?: string },
  ): Promise<void> {
    const evaluation = await this.evaluateTransition(fromState, toState, context);
    if (!evaluation.allowed) {
      throw new InvalidStateTransitionException({
        stateMachineName: this.definition.name,
        resourceType: metadata?.resourceType ?? this.definition.name,
        resourceId: metadata?.resourceId,
        currentState: fromState,
        attemptedState: toState,
        allowedTransitions: evaluation.allowedTransitions,
        reason: evaluation.reason,
      });
    }
  }

  /**
   * Executes a validated transition.
   */
  public async transition(
    fromState: TState,
    toState: TState,
    context?: TContext,
    metadata?: { resourceId?: string; resourceType?: string },
  ): Promise<TState> {
    await this.assertCanTransition(fromState, toState, context, metadata);
    this.logger.log(
      `Transition ${metadata?.resourceType ?? this.definition.name}${
        metadata?.resourceId ? `[${metadata.resourceId}]` : ""
      }: ${fromState} -> ${toState}${context?.reason ? ` (Reason: ${context.reason})` : ""}`,
    );
    return toState;
  }

  /**
   * Derives a unified state model for UI/API contracts.
   */
  public deriveStateModel(currentState: TState): StateDerivedModel<TState> {
    return {
      state: currentState,
      isTerminal: this.isTerminal(currentState),
      allowedTransitions: this.getAllowedTransitions(currentState),
      stateMetadata: this.getStateMetadata(currentState),
    };
  }
}
