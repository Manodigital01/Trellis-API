import { createHash } from "crypto";
import { SandboxScenario, isSandboxScenario } from "./sandbox.scenarios";

/**
 * Deterministic id/hash helpers for sandbox mode.
 *
 * Real adapters mint random UUIDs (`uuidv4()`) and rely on the network for
 * hashes. Sandbox mode must return the *same* value for the same input so that
 * tests can assert on it, so every identifier is derived from the configured
 * seed plus the request's stable fields via SHA-256.
 *
 * Sandbox ids are intentionally prefixed `sbx:<scenario>:<kind>:<hex>` rather
 * than being shaped like a Stellar hash or UUID — they are obviously fake and
 * cannot be mistaken for a ledger artifact, while still carrying the scenario
 * that produced them.
 */

/** Prefix that marks an id/payload as sandbox-generated. */
export const SANDBOX_ID_PREFIX = "sbx";

/** 32-hex-character body for generated ids. */
const ID_HEX_LENGTH = 32;

/**
 * Stable hex digest over the seed and the supplied parts. `undefined`/`null`
 * collapse to an empty component so callers can pass optional fields directly.
 */
export function sandboxDigest(
  seed: string,
  ...parts: Array<string | number | undefined | null>
): string {
  const payload = [seed, ...parts.map((p) => (p ?? "").toString())].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

function sandboxId(
  seed: string,
  scenario: SandboxScenario,
  kind: string,
  ...parts: Array<string | number | undefined | null>
): string {
  const body = sandboxDigest(seed, scenario, kind, ...parts).slice(
    0,
    ID_HEX_LENGTH,
  );
  return `${SANDBOX_ID_PREFIX}:${scenario}:${kind}:${body}`;
}

/** Local correlation id returned by `createPayment`. */
export function sandboxPaymentId(
  seed: string,
  scenario: SandboxScenario,
  idempotencyKey: string,
): string {
  return sandboxId(seed, scenario, "pay", idempotencyKey);
}

/** Stand-in for an on-chain transaction hash, returned by `submitTransaction`. */
export function sandboxTransactionHash(
  seed: string,
  scenario: SandboxScenario,
  paymentId: string,
): string {
  return sandboxId(seed, scenario, "tx", paymentId);
}

/** Refund id, derived from the payment id and the refund idempotency key. */
export function sandboxRefundId(
  seed: string,
  scenario: SandboxScenario,
  paymentId: string,
  idempotencyKey: string,
): string {
  return sandboxId(seed, scenario, "ref", paymentId, idempotencyKey);
}

/**
 * Unsigned payload returned by `createPayment`. It is self-describing: the
 * scenario and correlation id travel inside the payload so the sign/submit
 * steps stay stateless across HTTP requests, exactly like a real XDR would.
 */
export function sandboxUnsignedPayload(
  scenario: SandboxScenario,
  paymentId: string,
  idempotencyKey: string,
): string {
  return `${SANDBOX_ID_PREFIX}:${scenario}:unsigned:${paymentId}:${idempotencyKey}`;
}

/** Signed payload returned by `signTransaction`. */
export function sandboxSignedPayload(
  scenario: SandboxScenario,
  paymentId: string,
): string {
  return `${SANDBOX_ID_PREFIX}:${scenario}:signed:${paymentId}`;
}

/**
 * Recover the scenario encoded in a sandbox id or payload. Returns `undefined`
 * for anything that was not produced by this module, so callers can fall back
 * to the configured default scenario.
 */
export function scenarioFromSandboxId(value: unknown): SandboxScenario | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const [prefix, scenario] = value.split(":");
  if (prefix !== SANDBOX_ID_PREFIX || !isSandboxScenario(scenario)) {
    return undefined;
  }
  return scenario;
}
