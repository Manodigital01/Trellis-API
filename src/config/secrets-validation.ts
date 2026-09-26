/**
 * Secrets validation utilities for Trellis API.
 *
 * These helpers run at application startup (and in the diagnostics command) to
 * detect insecure, missing, or placeholder secrets before the server accepts
 * traffic.  Rules:
 *
 *  - Never log a secret in full — only the first/last two chars and masked middle.
 *  - Fail loudly in production for required production secrets.
 *  - Warn (never crash) in non-production environments.
 *
 * Issue: #66
 */

export interface SecretIssue {
  key: string;
  severity: "error" | "warning";
  message: string;
}

export interface SecretsValidationResult {
  ok: boolean;
  issues: SecretIssue[];
  /** Safely-masked summary of current secret values, safe to log. */
  maskedValues: Record<string, string>;
}

// ------------------------------------------------------------------
// Known placeholder values that should never reach production
// ------------------------------------------------------------------
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^your[-_]?/i,
  /placeholder/i,
  /changeme/i,
  /example/i,
  /^0x0{40}$/, // zero Ethereum address
  /^0x0{64}$/, // zero private key
  /^sk-your-/i,
  /^your_/i,
  /^todo/i,
  /^replace/i,
  /^fixme/i,
  /^<.*>$/, // <TOKEN> style
];

// ------------------------------------------------------------------
// Secrets that are REQUIRED in production mode
// ------------------------------------------------------------------
const PRODUCTION_REQUIRED: string[] = [
  "DATABASE_URL",
  "JWT_SECRET",
];

// ------------------------------------------------------------------
// Secrets with minimum entropy requirements (minimum Shannon entropy)
// ------------------------------------------------------------------
interface EntropyRule {
  key: string;
  minEntropy: number;
  minLength: number;
  description: string;
}

const ENTROPY_RULES: EntropyRule[] = [
  { key: "JWT_SECRET", minEntropy: 3.5, minLength: 32, description: "JWT signing key" },
  { key: "SUBMITTER_PRIVATE_KEY", minEntropy: 3.0, minLength: 64, description: "Ethereum private key" },
  { key: "GRANTFOX_ENCRYPTION_KEY", minEntropy: 3.5, minLength: 64, description: "AES-256-GCM key (32 raw bytes = 64 hex chars)" },
  { key: "STELLAR_SIGNING_SECRET", minEntropy: 3.5, minLength: 56, description: "Stellar signing secret (Sxxx... format)" },
  { key: "GRANTFOX_CLIENT_SECRET", minEntropy: 2.5, minLength: 16, description: "Grantfox OAuth client secret" },
];

// ------------------------------------------------------------------
// Secrets that must NOT look like cross-environment leaks
// ------------------------------------------------------------------
const PROD_FORBIDDEN_PATTERNS: Array<{ key: string; pattern: RegExp; hint: string }> = [
  {
    key: "DATABASE_URL",
    pattern: /localhost|127\.0\.0\.1/i,
    hint: "DATABASE_URL points to localhost — not safe for production",
  },
  {
    key: "DATABASE_URL",
    pattern: /password@localhost/i,
    hint: "DATABASE_URL appears to use a local dev password",
  },
  {
    key: "STELLAR_HORIZON_URL",
    pattern: /testnet/i,
    hint: "STELLAR_HORIZON_URL points to Stellar testnet — use mainnet in production",
  },
  {
    key: "STELLAR_NETWORK_PASSPHRASE",
    pattern: /test/i,
    hint: "STELLAR_NETWORK_PASSPHRASE is a test-network passphrase — use mainnet passphrase in production",
  },
];

// ------------------------------------------------------------------
// Shannon entropy calculation
// ------------------------------------------------------------------
function shannonEntropy(value: string): number {
  if (!value) return 0;
  const freq = new Map<string, number>();
  for (const char of value) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ------------------------------------------------------------------
// Safe masking — never expose more than the first/last 2 chars
// ------------------------------------------------------------------
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

// ------------------------------------------------------------------
// Check a single value against placeholder patterns
// ------------------------------------------------------------------
function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

// ------------------------------------------------------------------
// Main validation entry point
// ------------------------------------------------------------------
export function validateSecrets(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  isProduction = process.env.NODE_ENV === "production",
): SecretsValidationResult {
  const issues: SecretIssue[] = [];
  const maskedValues: Record<string, string> = {};

  // 1. Production-required keys must be present
  for (const key of PRODUCTION_REQUIRED) {
    const value = env[key];
    maskedValues[key] = maskSecret(value);
    if (!value || value.trim() === "") {
      issues.push({
        key,
        severity: isProduction ? "error" : "warning",
        message: `${key} is not set. ${isProduction ? "This is required in production." : "Set it before deploying."}`,
      });
    }
  }

  // 2. Entropy / length checks for secret keys
  for (const rule of ENTROPY_RULES) {
    const value = env[rule.key];
    if (!value) {
      // Missing optional secrets only warn
      if (!PRODUCTION_REQUIRED.includes(rule.key)) {
        maskedValues[rule.key] = maskSecret(value);
        if (isProduction) {
          issues.push({
            key: rule.key,
            severity: "warning",
            message: `${rule.key} is not set. If you use ${rule.description}, set this before enabling that feature.`,
          });
        }
      }
      continue;
    }

    maskedValues[rule.key] = maskSecret(value);

    if (isPlaceholder(value)) {
      issues.push({
        key: rule.key,
        severity: isProduction ? "error" : "warning",
        message: `${rule.key} appears to be a placeholder value. Replace with a real ${rule.description}.`,
      });
      continue; // Skip entropy check on obvious placeholders
    }

    if (value.length < rule.minLength) {
      issues.push({
        key: rule.key,
        severity: isProduction ? "error" : "warning",
        message: `${rule.key} is too short (${value.length} chars, minimum ${rule.minLength}). ${rule.description} must be adequately long.`,
      });
    }

    const entropy = shannonEntropy(value);
    if (entropy < rule.minEntropy) {
      issues.push({
        key: rule.key,
        severity: isProduction ? "error" : "warning",
        message:
          `${rule.key} has low entropy (${entropy.toFixed(2)} bits/char, minimum ${rule.minEntropy}). ` +
          `${rule.description} may be predictable — use a cryptographically random value.`,
      });
    }
  }

  // 3. Placeholder checks for all non-empty env values that aren't already checked
  const alreadyChecked = new Set([
    ...PRODUCTION_REQUIRED,
    ...ENTROPY_RULES.map((r) => r.key),
  ]);

  const sensitiveKeys = Object.keys(env).filter(
    (k) =>
      !alreadyChecked.has(k) &&
      (k.toLowerCase().includes("secret") ||
        k.toLowerCase().includes("key") ||
        k.toLowerCase().includes("password") ||
        k.toLowerCase().includes("token") ||
        k.toLowerCase().includes("dsn") ||
        k.toLowerCase().includes("signing")),
  );

  for (const key of sensitiveKeys) {
    const value = env[key];
    if (!value) continue;
    maskedValues[key] = maskSecret(value);
    if (isPlaceholder(value)) {
      issues.push({
        key,
        severity: isProduction ? "error" : "warning",
        message: `${key} appears to be a placeholder value. Replace it with a real secret before deploying.`,
      });
    }
  }

  // 4. Production-specific cross-environment checks
  if (isProduction) {
    for (const { key, pattern, hint } of PROD_FORBIDDEN_PATTERNS) {
      const value = env[key];
      if (value && pattern.test(value)) {
        issues.push({ key, severity: "error", message: hint });
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    ok: !hasErrors,
    issues,
    maskedValues,
  };
}

/**
 * Run secrets validation and throw if any hard errors are found in production.
 * Logs warnings for non-fatal issues using the provided logger.
 *
 * Usage (in bootstrap or AppModule.onModuleInit):
 *   assertSecretsValid(process.env, logger);
 */
export function assertSecretsValid(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  logger: { warn: (msg: string) => void; error: (msg: string) => void },
): void {
  const isProduction = env.NODE_ENV === "production";
  const result = validateSecrets(env, isProduction);

  for (const issue of result.issues) {
    const masked = result.maskedValues[issue.key]
      ? ` (current: ${result.maskedValues[issue.key]})`
      : "";
    const msg = `[secrets] ${issue.key}: ${issue.message}${masked}`;
    if (issue.severity === "error") {
      logger.error(msg);
    } else {
      logger.warn(msg);
    }
  }

  if (!result.ok && isProduction) {
    throw new Error(
      `Application startup aborted: ${result.issues.filter((i) => i.severity === "error").length} secret(s) failed validation. ` +
        "Review the error messages above, correct the environment variables, and restart.",
    );
  }
}
