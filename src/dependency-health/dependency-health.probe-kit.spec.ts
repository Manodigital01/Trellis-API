/**
 * Unit tests for the dependency health redaction, classification and
 * aggregation logic.
 *
 * Issue: #124
 */

import {
  applyLatencyBudget,
  buildDependencyReport,
  classifyHttpOutcome,
  classifyThrownError,
  isPlaceholderValue,
  isSecretEnvKey,
  isTimeoutError,
  redactSecretValues,
  sanitizeDependencyMessage,
  sanitizeTarget,
  scrubMessage,
} from "./dependency-health.probe-kit";
import { DependencyCheckResult, DependencyState } from "./dependency-health.types";
import { REDACTED } from "./dependency-health.probe-kit";

function check(
  overrides: Partial<DependencyCheckResult> & { id: string },
): DependencyCheckResult {
  return {
    label: overrides.id,
    kind: "service",
    criticality: "critical",
    state: "healthy",
    detail: "",
    verification: "configuration",
    configKeys: [],
    remediation: "",
    ...overrides,
  };
}

describe("dependency health probe kit", () => {
  describe("secret detection", () => {
    it.each([
      ["JWT_SECRET", true],
      ["SMTP_PASSWORD", true],
      ["SUBMITTER_PRIVATE_KEY", true],
      ["OPENAI_API_KEY", true],
      ["AWS_SECRET_ACCESS_KEY", true],
      ["SENTRY_DSN", true],
      ["DATABASE_URL", false],
      ["REDIS_URL", false],
      ["STELLAR_HORIZON_URL", false],
    ])("classifies %s as secret=%s", (key, expected) => {
      expect(isSecretEnvKey(key)).toBe(expected);
    });

    it.each([
      ["your-secret-here", true],
      ["placeholder", true],
      ["changeme", true],
      ["<token>", true],
      ["sk-your-key", true],
      ["3f9a1c7b2e4d5a6f8c0b1d2e3f4a5b6c", false],
    ])("detects placeholder value %s", (value, expected) => {
      expect(isPlaceholderValue(value)).toBe(expected);
    });
  });

  describe("message sanitisation", () => {
    it("never lets a configured secret value reach the output", () => {
      const env = { JWT_SECRET: "s3cr3t-jwt-value-9876543210" };
      const message = sanitizeDependencyMessage(
        "connect failed for key s3cr3t-jwt-value-9876543210",
        env,
      );
      expect(message).not.toContain("s3cr3t-jwt-value-9876543210");
      expect(message).toContain(REDACTED);
    });

    it("redacts url credentials", () => {
      const scrubbed = scrubMessage(
        "connect ECONNREFUSED postgresql://admin:sup3rs3cret@db.internal:5432/trellis",
      );
      expect(scrubbed).not.toContain("sup3rs3cret");
      expect(scrubbed).toContain("postgresql://");
      expect(scrubbed).toContain("@db.internal:5432/trellis");
    });

    it("redacts key=value and key: value secret assignments", () => {
      expect(
        scrubMessage("SMTP_PASSWORD=hunter2 while dialling"),
      ).not.toContain("hunter2");
      expect(
        scrubMessage('{"api_key": "abc123def456"}'),
      ).not.toContain("abc123def456");
    });

    it("masks long opaque tokens such as signatures and hashes", () => {
      const token = "a".repeat(64);
      expect(scrubMessage(`signature ${token} accepted`)).not.toContain(token);
    });

    it("masks private key blocks", () => {
      const pem = [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ",
        "-----END PRIVATE KEY-----",
      ].join("\n");
      const scrubbed = scrubMessage(pem);
      expect(scrubbed).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ");
      expect(scrubbed).toContain(REDACTED);
    });

    it("truncates very long messages", () => {
      const scrubbed = scrubMessage("dependency probe detail. ".repeat(40));
      expect(scrubbed.length).toBeLessThanOrEqual(300);
      expect(scrubbed.endsWith("…")).toBe(true);
    });

    it("ignores short env values when redacting to avoid mangling output", () => {
      expect(redactSecretValues("value is 42", ["42"])).toBe("value is 42");
    });

    it("strips credentials and query strings from targets", () => {
      expect(
        sanitizeTarget("https://user:pw@horizon.example.org/v1?token=abc"),
      ).toBe("https://horizon.example.org/v1");
    });
  });

  describe("error classification", () => {
    it.each([
      ["connect ECONNREFUSED 127.0.0.1:5432", "unavailable"],
      ["getaddrinfo ENOTFOUND horizon.invalid", "unavailable"],
      ["database health check timed out after 3000ms", "unavailable"],
      ["socket hang up", "unavailable"],
      ["password authentication failed for user \"trellis\"", "misconfigured"],
      ["invalid url in DATABASE_URL", "misconfigured"],
      ["unsupported protocol", "misconfigured"],
    ])("classifies %s as %s", (message, expected) => {
      expect(classifyThrownError(new Error(message))).toBe(expected);
    });

    it("treats an unknown failure as unavailable rather than healthy", () => {
      expect(classifyThrownError(new Error("kaboom"))).toBe("unavailable");
    });

    it("detects timeouts", () => {
      expect(isTimeoutError(new Error("probe timed out after 100ms"))).toBe(true);
      expect(isTimeoutError(new Error("ETIMEDOUT"))).toBe(true);
      expect(isTimeoutError(new Error("connection refused"))).toBe(false);
    });
  });

  describe("outcome classification", () => {
    it("treats 2xx as healthy within the latency budget", () => {
      expect(
        classifyHttpOutcome({ status: 200, latencyMs: 10, degradedLatencyMs: 1000 }),
      ).toBe("healthy");
    });

    it("downgrades a slow 2xx to degraded", () => {
      expect(
        classifyHttpOutcome({ status: 200, latencyMs: 2000, degradedLatencyMs: 1000 }),
      ).toBe("degraded");
    });

    it("treats 429 and 5xx as degraded because the host did answer", () => {
      expect(
        classifyHttpOutcome({ status: 429, latencyMs: 5, degradedLatencyMs: 1000 }),
      ).toBe("degraded");
      expect(
        classifyHttpOutcome({ status: 503, latencyMs: 5, degradedLatencyMs: 1000 }),
      ).toBe("degraded");
    });

    it("applies the latency budget independently of the transport", () => {
      expect(applyLatencyBudget(10, 1000)).toBe("healthy");
      expect(applyLatencyBudget(1001, 1000)).toBe("degraded");
    });
  });

  describe("report aggregation", () => {
    const states: DependencyState[] = [
      "healthy",
      "degraded",
      "unavailable",
      "misconfigured",
    ];

    it.each(states)("reports %s status when a critical dependency is %s", (state) => {
      const report = buildDependencyReport(
        [
          check({ id: "database", state: "healthy" }),
          check({ id: "redis", state }),
        ],
        5,
        false,
        "2026-09-27T00:00:00.000Z",
      );
      expect(report.status).toBe(state);
    });

    it("does not let an optional dependency gate the report", () => {
      const report = buildDependencyReport(
        [
          check({ id: "database", state: "healthy" }),
          check({
            id: "elasticsearch",
            criticality: "optional",
            state: "unavailable",
          }),
        ],
        5,
        false,
        "2026-09-27T00:00:00.000Z",
      );
      expect(report.status).toBe("healthy");
      expect(report.advisory).toBe("unavailable");
      expect(report.advisoryFindings).toEqual(["elasticsearch"]);
      expect(report.criticalFindings).toEqual([]);
    });

    it("prefers misconfigured over unavailable in the findings order", () => {
      const report = buildDependencyReport(
        [
          check({ id: "redis", state: "unavailable" }),
          check({ id: "eth_rpc", state: "misconfigured" }),
          check({ id: "stellar_horizon", state: "degraded" }),
        ],
        5,
        false,
        "2026-09-27T00:00:00.000Z",
      );
      expect(report.criticalFindings).toEqual([
        "eth_rpc",
        "redis",
        "stellar_horizon",
      ]);
    });

    it("counts disabled checks without treating them as findings", () => {
      const report = buildDependencyReport(
        [
          check({ id: "database", state: "healthy" }),
          check({
            id: "sentry",
            criticality: "optional",
            state: "disabled",
          }),
        ],
        5,
        true,
        "2026-09-27T00:00:00.000Z",
      );
      expect(report.counts.disabled).toBe(1);
      expect(report.advisoryFindings).toEqual([]);
      expect(report.networkProbesSkipped).toBe(true);
    });
  });
});
