import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PaymentStatus } from "src/payments/interfaces/payment-processor.interface";
import { SandboxScenario } from "src/sandbox/sandbox.scenarios";

/**
 * Canned success and failure fixtures for sandbox mode.
 *
 * Each fixture describes the terminal status of every payment lifecycle step
 * plus, optionally, the single step that fails and how. The sandbox adapter is
 * a thin interpreter over these fixtures, which keeps the interesting data in
 * one reviewable place instead of scattered through control flow.
 */

/** Lifecycle step a fixture can fail on. */
export type SandboxStep = "create" | "sign" | "submit" | "status" | "refund";

/** How a failing step surfaces to the caller. */
export type SandboxFailureKind = "invalid_request" | "unavailable";

export interface SandboxFailure {
  /** Step that raises. */
  step: SandboxStep;
  /** Exception family: 400 (permanent) or 503 (transient/retryable). */
  kind: SandboxFailureKind;
  /** Fixed message, so repeated calls are byte-for-byte identical. */
  message: string;
}

export interface SandboxFixture {
  scenario: SandboxScenario;
  description: string;
  /** Status returned by `createPayment`. */
  createStatus: PaymentStatus;
  /** Status returned by `submitTransaction`. */
  submitStatus: PaymentStatus;
  /** Status returned by `getStatus`. */
  statusStatus: PaymentStatus;
  /** Status returned by `refund`. */
  refundStatus: PaymentStatus;
  /** Amount reported as settled/refunded when the caller omits one. */
  confirmedAmount: string;
  /** When present, the step that fails instead of succeeding. */
  failure?: SandboxFailure;
}

export const SANDBOX_FIXTURES: Record<SandboxScenario, SandboxFixture> = {
  [SandboxScenario.SUCCESS]: {
    scenario: SandboxScenario.SUCCESS,
    description: "Happy path: the payment confirms and is fully refundable.",
    createStatus: PaymentStatus.PENDING,
    submitStatus: PaymentStatus.CONFIRMED,
    statusStatus: PaymentStatus.CONFIRMED,
    refundStatus: PaymentStatus.REFUNDED,
    confirmedAmount: "10",
  },
  [SandboxScenario.PAYMENT_FAILED]: {
    scenario: SandboxScenario.PAYMENT_FAILED,
    description: "Submission settles as FAILED, so the payment is not refundable.",
    createStatus: PaymentStatus.PENDING,
    submitStatus: PaymentStatus.FAILED,
    statusStatus: PaymentStatus.FAILED,
    refundStatus: PaymentStatus.FAILED,
    confirmedAmount: "0",
    failure: {
      step: "refund",
      kind: "invalid_request",
      message:
        'Sandbox scenario "payment_failed": a failed payment cannot be refunded.',
    },
  },
  [SandboxScenario.INSUFFICIENT_FUNDS]: {
    scenario: SandboxScenario.INSUFFICIENT_FUNDS,
    description: "Creation is rejected because the sandbox account has no balance.",
    createStatus: PaymentStatus.FAILED,
    submitStatus: PaymentStatus.FAILED,
    statusStatus: PaymentStatus.FAILED,
    refundStatus: PaymentStatus.FAILED,
    confirmedAmount: "0",
    failure: {
      step: "create",
      kind: "invalid_request",
      message:
        'Sandbox scenario "insufficient_funds": sandbox account has insufficient balance.',
    },
  },
  [SandboxScenario.HORIZON_TIMEOUT]: {
    scenario: SandboxScenario.HORIZON_TIMEOUT,
    description: "Submission raises a transient Horizon timeout that is safe to retry.",
    createStatus: PaymentStatus.PENDING,
    submitStatus: PaymentStatus.PENDING,
    statusStatus: PaymentStatus.PENDING,
    refundStatus: PaymentStatus.REFUNDED,
    confirmedAmount: "0",
    failure: {
      step: "submit",
      kind: "unavailable",
      message:
        'Sandbox scenario "horizon_timeout": sandbox Horizon timed out; retry is safe.',
    },
  },
};

/** Fixture for a scenario. Total by construction — the record covers the enum. */
export function getSandboxFixture(scenario: SandboxScenario): SandboxFixture {
  return SANDBOX_FIXTURES[scenario];
}

/** Serializable summary of every fixture, for docs and `describe()` output. */
export function listSandboxFixtures(): Array<{
  scenario: SandboxScenario;
  description: string;
  failingStep: SandboxStep | null;
}> {
  return Object.values(SANDBOX_FIXTURES).map((fixture) => ({
    scenario: fixture.scenario,
    description: fixture.description,
    failingStep: fixture.failure?.step ?? null,
  }));
}

/** Map a fixture failure onto the HTTP-shaped exception it should raise. */
export function sandboxFailureException(failure: SandboxFailure): HttpException {
  return failure.kind === "unavailable"
    ? new ServiceUnavailableException(failure.message)
    : new BadRequestException(failure.message);
}
