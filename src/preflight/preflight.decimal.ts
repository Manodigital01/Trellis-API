import { PREFLIGHT_DECIMAL_SCALE } from "./preflight.constants";

/**
 * Exact decimal-string arithmetic for the preflight core.
 *
 * Amounts in this API are decimal strings (`^\d+(\.\d+)?$`), never floats, so
 * all comparisons are performed on scaled `bigint`s. That keeps results exact
 * and — critically for the preflight — bit-for-bit reproducible across runs,
 * which JavaScript `number` arithmetic is not.
 */

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** True when `value` is a non-negative decimal string. */
export function isDecimalString(value: unknown): boolean {
  return typeof value === "string" && DECIMAL_PATTERN.test(value.trim());
}

function splitDecimal(value: string): { integer: string; fraction: string } {
  const trimmed = value.trim();
  const [integer, fraction = ""] = trimmed.split(".");
  return { integer: integer || "0", fraction };
}

function scaledParts(
  a: string,
  b: string,
): { a: bigint; b: bigint; scale: number } {
  const left = splitDecimal(a);
  const right = splitDecimal(b);
  const scale = Math.max(left.fraction.length, right.fraction.length);
  return {
    a: BigInt(left.integer + left.fraction.padEnd(scale, "0")),
    b: BigInt(right.integer + right.fraction.padEnd(scale, "0")),
    scale,
  };
}

/** Render a scaled bigint back to a canonical decimal string. */
function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const padded = absolute.toString().padStart(scale + 1, "0");
  const integer = padded.slice(0, padded.length - scale);
  const fraction = scale > 0 ? padded.slice(padded.length - scale) : "";
  const trimmedFraction = fraction.replace(/0+$/, "");
  const rendered = trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
  return negative && rendered !== "0" ? `-${rendered}` : rendered;
}

/**
 * Trim a decimal string to its canonical form (`"10.500"` -> `"10.5"`,
 * `"0.0"` -> `"0"`). Used so equal amounts hash identically.
 */
export function normalizeDecimal(value: string): string {
  const { a, scale } = scaledParts(value, "0");
  return formatScaled(a, scale);
}

/** Compare two decimal strings: `-1`, `0` or `1`. */
export function compareDecimal(a: string, b: string): number {
  const { a: left, b: right } = scaledParts(a, b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** `a - b` as a canonical decimal string (may be negative). */
export function subtractDecimal(a: string, b: string): string {
  const { a: left, b: right, scale } = scaledParts(a, b);
  return formatScaled(left - right, scale);
}

/** `a + b` as a canonical decimal string. */
export function addDecimal(a: string, b: string): string {
  const { a: left, b: right, scale } = scaledParts(a, b);
  return formatScaled(left + right, scale);
}

/** Scale a decimal string by a power of ten (for oracle staleness math). */
export function toScaledInteger(
  value: string,
  scale: number = PREFLIGHT_DECIMAL_SCALE,
): bigint {
  const { integer, fraction } = splitDecimal(value);
  const padded = fraction.padEnd(scale, "0").slice(0, scale);
  return BigInt(integer + padded);
}
