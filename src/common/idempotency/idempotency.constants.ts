/**
 * Shared constants for the idempotency / replay-protection layer.
 *
 * Callers send a client-generated `Idempotency-Key` header on mutating
 * requests. The value is only ever used as a lookup key together with the
 * resolved scope, so it does not need to be secret - it must simply be unique
 * per logical operation and stable across retries.
 */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Header set on every response so clients can tell a replay from a fresh run. */
export const IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed";

/** Metadata key used by the `@Idempotent()` decorator. */
export const IDEMPOTENCY_OPTIONS = "idempotency:options";

/** HTTP methods that can mutate state and therefore participate in replay protection. */
export const IDEMPOTENT_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * Conservative character set: keys end up in log lines and headers, so keep
 * them printable, URL-safe, and free of whitespace/control characters.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:+-]+$/;

/** How long a completed response stays replayable. */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Upper bound accepted from callers so a rogue value cannot pin rows forever. */
export const MAX_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
