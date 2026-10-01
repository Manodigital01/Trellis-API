/**
 * Named sandbox scenarios. A scenario selects which {@link SandboxFixture}
 * drives a sandbox payment, so a contributor can reproduce a success or a
 * failure path without a network call.
 *
 * The active scenario is chosen per request via `metadata.sandboxScenario` on
 * `POST /payments`, falling back to `SANDBOX_SCENARIO`.
 */
export enum SandboxScenario {
  /** Happy path: create → sign → submit → confirmed → full refund. */
  SUCCESS = "success",
  /** Submission settles as FAILED and the payment is not refundable. */
  PAYMENT_FAILED = "payment_failed",
  /** `createPayment` rejects because the sandbox account has no balance. */
  INSUFFICIENT_FUNDS = "insufficient_funds",
  /** `submitTransaction` raises a transient, retryable Horizon error. */
  HORIZON_TIMEOUT = "horizon_timeout",
}

/** All scenario values, in declaration order. */
export const SANDBOX_SCENARIO_VALUES: SandboxScenario[] =
  Object.values(SandboxScenario);

/** Scenario used when neither the request nor the env selects one. */
export const DEFAULT_SANDBOX_SCENARIO = SandboxScenario.SUCCESS;

/** Type guard for an untrusted value coming from request metadata or the env. */
export function isSandboxScenario(value: unknown): value is SandboxScenario {
  return (
    typeof value === "string" &&
    (SANDBOX_SCENARIO_VALUES as string[]).includes(value)
  );
}
