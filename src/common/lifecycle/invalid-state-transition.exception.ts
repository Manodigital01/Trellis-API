import { BadRequestException, HttpStatus } from "@nestjs/common";

export interface InvalidStateTransitionDetails {
  stateMachineName: string;
  currentState: string;
  attemptedState: string;
  allowedTransitions: string[];
  resourceId?: string;
  resourceType?: string;
  reason?: string;
}

/**
 * Thrown when a state machine rejects an invalid or guarded lifecycle transition.
 * Standardizes machine-readable error responses across the API and UI.
 */
export class InvalidStateTransitionException extends BadRequestException {
  public readonly details: InvalidStateTransitionDetails;

  constructor(details: InvalidStateTransitionDetails) {
    const message = details.reason
      ? `Invalid lifecycle transition for ${details.resourceType || details.stateMachineName}${
          details.resourceId ? ` [${details.resourceId}]` : ""
        }: cannot transition from '${details.currentState}' to '${details.attemptedState}'. Reason: ${details.reason}. Allowed transitions: [${details.allowedTransitions.join(", ")}]`
      : `Invalid lifecycle transition for ${details.resourceType || details.stateMachineName}${
          details.resourceId ? ` [${details.resourceId}]` : ""
        }: cannot transition from '${details.currentState}' to '${details.attemptedState}'. Allowed transitions: [${details.allowedTransitions.join(", ")}]`;

    super({
      statusCode: HttpStatus.BAD_REQUEST,
      error: "InvalidStateTransition",
      message,
      stateMachine: details.stateMachineName,
      resourceType: details.resourceType,
      resourceId: details.resourceId,
      currentState: details.currentState,
      attemptedState: details.attemptedState,
      allowedTransitions: details.allowedTransitions,
      reason: details.reason,
    });

    this.details = details;
  }

  get stateMachineName(): string {
    return this.details.stateMachineName;
  }

  get currentState(): string {
    return this.details.currentState;
  }

  get attemptedState(): string {
    return this.details.attemptedState;
  }

  get allowedTransitions(): string[] {
    return this.details.allowedTransitions;
  }

  get resourceId(): string | undefined {
    return this.details.resourceId;
  }

  get resourceType(): string | undefined {
    return this.details.resourceType;
  }
}
