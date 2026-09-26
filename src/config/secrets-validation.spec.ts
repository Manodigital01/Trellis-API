import {
  validateSecrets,
  assertSecretsValid,
  maskSecret,
} from "./secrets-validation";

// Minimal valid dev environment
const VALID_DEV_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://trellis:devpassword@localhost:5432/trellis_dev",
  JWT_SECRET: "a-very-long-and-random-jwt-secret-that-has-enough-entropy-123!",
};

const VALID_PROD_ENV: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://trellis:s3cr3tPass!@db.prod.example.com:5432/trellis",
  JWT_SECRET: "Xk9#mP2$vL7&nQ4@wR1^tY6!uI3%oE8*aS5-dF0+gH2",
};

describe("maskSecret", () => {
  it("masks long secrets showing only first/last 2 chars", () => {
    const masked = maskSecret("supersecretvalue");
    expect(masked).toMatch(/^su\*+ue$/);
  });

  it("returns (not set) for undefined", () => {
    expect(maskSecret(undefined)).toBe("(not set)");
  });

  it("returns (not set) for empty string", () => {
    expect(maskSecret("")).toBe("(not set)");
  });

  it("masks very short secrets as ****", () => {
    expect(maskSecret("ab")).toBe("****");
    expect(maskSecret("abcd")).toBe("****");
  });
});

describe("validateSecrets – development environment", () => {
  it("passes with valid dev credentials", () => {
    const result = validateSecrets(VALID_DEV_ENV, false);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("warns (not errors) when DATABASE_URL is missing in dev", () => {
    const env = { ...VALID_DEV_ENV };
    delete (env as any).DATABASE_URL;
    const result = validateSecrets(env, false);
    const issue = result.issues.find((i) => i.key === "DATABASE_URL");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
    expect(result.ok).toBe(true); // no errors → ok is still true
  });

  it("warns (not errors) when JWT_SECRET is a placeholder in dev", () => {
    const env = { ...VALID_DEV_ENV, JWT_SECRET: "your_jwt_secret_key_here" };
    const result = validateSecrets(env, false);
    const issue = result.issues.find((i) => i.key === "JWT_SECRET");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  it("warns when JWT_SECRET is too short", () => {
    const env = { ...VALID_DEV_ENV, JWT_SECRET: "short" };
    const result = validateSecrets(env, false);
    const issue = result.issues.find(
      (i) => i.key === "JWT_SECRET" && i.message.includes("short"),
    );
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  it("warns about low entropy JWT secret", () => {
    const env = { ...VALID_DEV_ENV, JWT_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const result = validateSecrets(env, false);
    const issue = result.issues.find(
      (i) => i.key === "JWT_SECRET" && i.message.includes("entropy"),
    );
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });
});

describe("validateSecrets – production environment", () => {
  it("passes with valid production credentials", () => {
    const result = validateSecrets(VALID_PROD_ENV, true);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors when DATABASE_URL is missing in production", () => {
    const env = { ...VALID_PROD_ENV };
    delete (env as any).DATABASE_URL;
    const result = validateSecrets(env, true);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.key === "DATABASE_URL");
    expect(issue!.severity).toBe("error");
  });

  it("errors when JWT_SECRET is missing in production", () => {
    const env = { ...VALID_PROD_ENV };
    delete (env as any).JWT_SECRET;
    const result = validateSecrets(env, true);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.key === "JWT_SECRET");
    expect(issue!.severity).toBe("error");
  });

  it("errors when JWT_SECRET is a placeholder in production", () => {
    const env = { ...VALID_PROD_ENV, JWT_SECRET: "your_jwt_secret_key_here" };
    const result = validateSecrets(env, true);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.key === "JWT_SECRET");
    expect(issue!.severity).toBe("error");
  });

  it("errors when DATABASE_URL points to localhost in production", () => {
    const env = {
      ...VALID_PROD_ENV,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/trellis",
    };
    const result = validateSecrets(env, true);
    expect(result.ok).toBe(false);
    const issue = result.issues.find(
      (i) => i.key === "DATABASE_URL" && i.message.includes("localhost"),
    );
    expect(issue!.severity).toBe("error");
  });

  it("errors when STELLAR_HORIZON_URL points to testnet in production", () => {
    const env = {
      ...VALID_PROD_ENV,
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    };
    const result = validateSecrets(env, true);
    const issue = result.issues.find((i) => i.key === "STELLAR_HORIZON_URL");
    expect(issue!.severity).toBe("error");
  });

  it("errors when Grantfox encryption key is too short", () => {
    const env = {
      ...VALID_PROD_ENV,
      GRANTFOX_ENCRYPTION_KEY: "shortkey",
    };
    const result = validateSecrets(env, true);
    const issue = result.issues.find((i) => i.key === "GRANTFOX_ENCRYPTION_KEY");
    expect(issue!.severity).toBe("error");
  });

  it("never exposes full secret values in maskedValues", () => {
    const secret = "Xk9#mP2$vL7&nQ4@wR1^tY6!uI3%oE8*aS5-dF0+gH2";
    const env = { ...VALID_PROD_ENV, JWT_SECRET: secret };
    const result = validateSecrets(env, true);
    const masked = result.maskedValues["JWT_SECRET"];
    expect(masked).not.toBe(secret);
    expect(masked).not.toContain(secret.slice(3, -3));
  });
});

describe("validateSecrets – placeholder detection", () => {
  const cases: Array<[string, string]> = [
    ["JWT_SECRET", "your_jwt_secret_key_here"],
    ["JWT_SECRET", "PLACEHOLDER_REPLACE_ME"],
    ["JWT_SECRET", "changeme"],
    ["SUBMITTER_PRIVATE_KEY", "0x0000000000000000000000000000000000000000000000000000000000000000"],
    ["SUBMITTER_PRIVATE_KEY", "<YOUR_PRIVATE_KEY>"],
    ["SMTP_PASSWORD", "your_smtp_password"],
  ];

  it.each(cases)("detects placeholder in %s=%s", (key, value) => {
    const env: Record<string, string> = {
      ...VALID_DEV_ENV,
      [key]: value,
    };
    const result = validateSecrets(env, false);
    const issue = result.issues.find((i) => i.key === key);
    expect(issue).toBeDefined();
    expect(issue!.message).toMatch(/placeholder/i);
  });
});

describe("assertSecretsValid", () => {
  it("does not throw in dev with warnings", () => {
    const env = { ...VALID_DEV_ENV, JWT_SECRET: "your_jwt_secret" };
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() => assertSecretsValid(env as any, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("throws in production when errors are found", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    } as Record<string, string>;
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() => assertSecretsValid(env, logger)).toThrow(
      /startup aborted/i,
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not throw in production when all secrets are valid", () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(() => assertSecretsValid(VALID_PROD_ENV as any, logger)).not.toThrow();
  });
});
