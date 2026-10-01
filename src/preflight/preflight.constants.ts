/**
 * Constants and environment keys for the transaction simulation preflight
 * (issue #109).
 *
 * The preflight core is a *pure* function: everything it needs to reach a
 * decision travels in the operation descriptor, the state snapshot and this
 * threshold block. No clocks, no I/O, no randomness live here — the caller
 * supplies `asOf` so the same input always produces the same result.
 */

/** Version of the evaluation contract. Bump when rule semantics change. */
export const PREFLIGHT_EVALUATION_VERSION = "preflight/1";

/** How long a caller-supplied state snapshot stays trustworthy (blocking). */
export const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 120;

/** Age at which a snapshot is reported as "aging" but still usable (warning). */
export const DEFAULT_WARN_SNAPSHOT_AGE_SECONDS = 60;

/** How old an oracle price may be before it is treated as stale (blocking). */
export const DEFAULT_MAX_ORACLE_AGE_SECONDS = 60;

/** Env override: hard freshness limit for a state snapshot, in seconds. */
export const PREFLIGHT_MAX_SNAPSHOT_AGE_ENV = "PREFLIGHT_MAX_SNAPSHOT_AGE_SECONDS";

/** Env override: soft freshness threshold for a state snapshot, in seconds. */
export const PREFLIGHT_WARN_SNAPSHOT_AGE_ENV = "PREFLIGHT_WARN_SNAPSHOT_AGE_SECONDS";

/** Env override: maximum acceptable oracle price age, in seconds. */
export const PREFLIGHT_MAX_ORACLE_AGE_ENV = "PREFLIGHT_MAX_ORACLE_AGE_SECONDS";

/**
 * Decimal scale used for every amount comparison. Amounts are decimal strings
 * (`^\d+(\.\d+)?$`), never floats, so comparisons stay exact and deterministic.
 */
export const PREFLIGHT_DECIMAL_SCALE = 18;
