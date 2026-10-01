/**
 * Deterministic Lifecycle State Machine Interfaces
 * 
 * Provides type-safe contracts for states, transitions, guards,
 * audit hooks, and derived API models.
 */

export interface TransitionContext {
  actorId?: string;
  actorRole?: string;
  reason?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

export type TransitionGuard<TContext = TransitionContext> = (
  context?: TContext,
) => boolean | Promise<boolean> | string; // string returns rejection reason

export interface TransitionRule<TState extends string, TContext = TransitionContext> {
  from: TState | TState[];
  to: TState;
  guard?: TransitionGuard<TContext>;
  description?: string;
  isAuditRequired?: boolean;
}

export interface StateMetadata<TState extends string> {
  state: TState;
  displayName: string;
  description: string;
  isTerminal: boolean;
  isLocked?: boolean; // When true, mutating operations on the record are disallowed
}

export interface StateMachineDefinition<TState extends string, TContext = TransitionContext> {
  name: string;
  initialState: TState;
  states: Record<TState, StateMetadata<TState>>;
  transitions: TransitionRule<TState, TContext>[];
}

export interface TransitionEvaluationResult<TState extends string> {
  allowed: boolean;
  fromState: TState;
  toState: TState;
  reason?: string;
  allowedTransitions: TState[];
  isTerminal?: boolean;
}

export interface StateDerivedModel<TState extends string> {
  state: TState;
  isTerminal: boolean;
  allowedTransitions: TState[];
  stateMetadata?: StateMetadata<TState>;
}
