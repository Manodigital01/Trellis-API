/**
 * Sanitizer for audit payloads.
 *
 * Audit rows are read by humans during incident review and are kept for years,
 * so they must not become a second copy of the secrets they describe. This
 * helper walks a payload and:
 *
 *  - replaces values of secret-looking keys with `[REDACTED]` (and reports the
 *    paths so reviewers can see that a field existed without seeing its value);
 *  - truncates very long strings instead of storing whole contracts/documents;
 *  - caps depth, array length, and drops non-JSON values (functions, symbols);
 *  - breaks reference cycles with `[Circular]`.
 *
 * The output is always plain JSON-serializable data.
 */
export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[Circular]";

export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_STRING_LENGTH = 500;
export const DEFAULT_MAX_ARRAY_LENGTH = 100;

/** Keys whose *values* must never be persisted, matched case-insensitively. */
export const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|passwd|authorization|auth[-_]?header|api[-_]?key|apikey|private[-_]?key|secret[-_]?key|seed|mnemonic|signature|signed[-_]?payload|cookie|session[-_]?id|otp|totp|pin|card[-_]?number|cvv|cvc|iban|ssn|routing[-_]?number|refresh[-_]?token|webhook[-_]?secret)/i;

export interface SanitizerOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
}

export interface SanitizationResult {
  value: Record<string, unknown> | null;
  /** JSON paths that were redacted, e.g. `["metadata.signingKey"]`. */
  redactedPaths: string[];
  /** True when depth, string length, or array length limits were hit. */
  truncated: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeAuditPayload(
  input: unknown,
  options: SanitizerOptions = {}
): SanitizationResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;

  const redactedPaths: string[] = [];
  let truncated = false;
  const ancestors: object[] = [];

  const walk = (value: unknown, path: string, depth: number): unknown => {
    if (value === null || value === undefined) return null;

    if (typeof value === "string") {
      if (value.length > maxStringLength) {
        truncated = true;
        return `${value.slice(0, maxStringLength)}...[truncated]`;
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();

    // Functions, symbols, and anything else non-serializable is dropped.
    if (typeof value !== "object") return undefined;

    if (ancestors.includes(value)) return CIRCULAR;

    if (depth >= maxDepth) {
      truncated = true;
      return REDACTED;
    }

    ancestors.push(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > maxArrayLength) truncated = true;
        return value
          .slice(0, maxArrayLength)
          .map((item, index) => walk(item, `${path}[${index}]`, depth + 1))
          .filter((item) => item !== undefined);
      }

      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          result[key] = REDACTED;
          redactedPaths.push(childPath);
          continue;
        }
        const walked = walk(source[key], childPath, depth + 1);
        if (walked !== undefined) result[key] = walked;
      }
      return result;
    } finally {
      ancestors.pop();
    }
  };

  const value = walk(input, "", 0);

  return {
    value: isPlainObject(value) ? value : null,
    redactedPaths,
    truncated,
  };
}
