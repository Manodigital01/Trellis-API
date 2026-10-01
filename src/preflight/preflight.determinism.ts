import { createHash } from "crypto";

/**
 * Deterministic ids and digests for the preflight (issue #109).
 *
 * This mirrors `src/sandbox/sandbox.determinism.ts`: every identifier is a
 * SHA-256 over the stable fields of the input, with a fixed namespace as the
 * seed. Nothing here touches a clock or randomness, so the same operation +
 * snapshot + `asOf` always yields the same `preflightId` and result digest.
 */

/** Prefix that marks an id as preflight-generated. */
export const PREFLIGHT_ID_PREFIX = "pf";

/** Seed mixed into every digest so domains cannot collide by accident. */
export const PREFLIGHT_DIGEST_NAMESPACE = "trellis-preflight";

/** Number of hex characters carried in a generated id. */
const ID_HEX_LENGTH = 32;

/**
 * Stable JSON for hashing: object keys are sorted recursively, so
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same digest. Arrays keep their order
 * — callers that treat an array as a set must normalise it first (see
 * `normalizeSnapshot` in `preflight.rules.ts`).
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

/**
 * SHA-256 over the seed and the supplied parts. `undefined`/`null` collapse to
 * an empty component, matching the sandbox helper, so optional fields can be
 * passed straight through.
 */
export function preflightDigest(
  seed: string,
  ...parts: Array<string | number | undefined | null>
): string {
  const payload = [seed, ...parts.map((part) => (part ?? "").toString())].join(
    "|",
  );
  return createHash("sha256").update(payload).digest("hex");
}

/** SHA-256 over the canonical form of an arbitrary value. */
export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

/** Build a `pf:<kind>:<hex>` identifier from an already-computed digest. */
export function preflightId(kind: string, digest: string): string {
  return `${PREFLIGHT_ID_PREFIX}:${kind}:${digest.slice(0, ID_HEX_LENGTH)}`;
}
