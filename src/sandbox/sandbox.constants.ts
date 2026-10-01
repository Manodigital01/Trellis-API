/**
 * Constants for integration sandbox mode (issue #57).
 *
 * Sandbox mode swaps the real external payment/chain dependencies for
 * deterministic, credential-free fakes so contributors can exercise the
 * primary payment workflow locally. It is opt-in (`SANDBOX_MODE=true`) and is
 * refused outright when `NODE_ENV=production` (see {@link SandboxConfigService}).
 */

/** Feature flag that turns sandbox mode on. Must be exactly "true". */
export const SANDBOX_MODE_ENV = "SANDBOX_MODE";

/** Default scenario used when a request does not name one. */
export const SANDBOX_SCENARIO_ENV = "SANDBOX_SCENARIO";

/** Seed that makes every generated id/hash reproducible. */
export const SANDBOX_SEED_ENV = "SANDBOX_SEED";

/** Stable selector key registered in the payment-processor registry. */
export const SANDBOX_PROCESSOR_NAME = "sandbox";

/** Default seed — changing it changes every generated id/hash. */
export const DEFAULT_SANDBOX_SEED = "trellis-local-sandbox";

/**
 * Address reported as the signer in sandbox mode. Deliberately not a valid
 * Ed25519 key so it can never be mistaken for a real account.
 */
export const SANDBOX_SIGNER_ADDRESS = "GBSANDBOX" + "0".repeat(47);
