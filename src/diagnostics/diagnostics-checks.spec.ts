import {
  checkEnvVars,
  checkToolVersion,
  checkTcpConnectivity,
  checkHttpEndpoint,
  buildReport,
  REQUIRED_ENV_SPECS,
  DiagnosticCheck,
} from "./diagnostics-checks";

// ──────────────────────────────────────────────────────────────────────────────
// checkEnvVars
// ──────────────────────────────────────────────────────────────────────────────
describe("checkEnvVars", () => {
  const validEnv: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/trellis",
    JWT_SECRET: "a-very-long-and-random-jwt-secret-that-is-enough-long",
    REDIS_URL: "redis://localhost:6379",
  };

  it("returns pass for all required vars when set with real values", () => {
    const checks = checkEnvVars(validEnv);
    for (const c of checks) {
      expect(c.status).toBe("pass");
    }
  });

  it("fails required vars that are missing", () => {
    const env: Record<string, string | undefined> = { ...validEnv };
    delete env.DATABASE_URL;
    const checks = checkEnvVars(env);
    const dbCheck = checks.find((c) => c.name === "env:DATABASE_URL");
    expect(dbCheck?.status).toBe("fail");
    expect(dbCheck?.remediation).toBeTruthy();
  });

  it("warns for optional vars that are missing", () => {
    const env: Record<string, string | undefined> = { ...validEnv };
    delete env.REDIS_URL;
    const checks = checkEnvVars(env);
    const redisCheck = checks.find((c) => c.name === "env:REDIS_URL");
    expect(redisCheck?.status).toBe("warn");
  });

  it("warns when a value looks like a placeholder", () => {
    const env = { ...validEnv, JWT_SECRET: "your_jwt_secret_here" };
    const checks = checkEnvVars(env);
    const jwtCheck = checks.find((c) => c.name === "env:JWT_SECRET");
    expect(jwtCheck?.status).toBe("warn");
    expect(jwtCheck?.detail).toMatch(/placeholder/i);
  });

  it("detects changeme placeholder", () => {
    const env = { ...validEnv, JWT_SECRET: "changeme_now" };
    const checks = checkEnvVars(env);
    const jwtCheck = checks.find((c) => c.name === "env:JWT_SECRET");
    expect(jwtCheck?.status).toBe("warn");
  });

  it("handles custom specs", () => {
    const checks = checkEnvVars(
      { CUSTOM_KEY: "value" },
      [{ key: "CUSTOM_KEY", required: true, hint: "custom", remediation: "set it" }],
    );
    expect(checks[0].status).toBe("pass");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkToolVersion
// ──────────────────────────────────────────────────────────────────────────────
describe("checkToolVersion", () => {
  it("passes when tool is found with no version constraint", () => {
    const result = checkToolVersion({
      name: "git",
      version: "2.44.0",
      required: true,
      remediation: "install git",
    });
    expect(result.status).toBe("pass");
  });

  it("passes when tool meets minimum major version", () => {
    const result = checkToolVersion({
      name: "node",
      version: "v20.5.1",
      minMajor: 18,
      required: true,
      remediation: "upgrade node",
    });
    expect(result.status).toBe("pass");
  });

  it("fails when tool is below minimum major version", () => {
    const result = checkToolVersion({
      name: "node",
      version: "v16.0.0",
      minMajor: 18,
      required: true,
      remediation: "upgrade node to 18+",
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/below minimum/);
    expect(result.remediation).toBe("upgrade node to 18+");
  });

  it("fails required tool when version is null", () => {
    const result = checkToolVersion({
      name: "psql",
      version: null,
      required: true,
      remediation: "install psql",
    });
    expect(result.status).toBe("fail");
  });

  it("warns optional tool when version is null", () => {
    const result = checkToolVersion({
      name: "docker",
      version: null,
      required: false,
      remediation: "install docker (optional)",
    });
    expect(result.status).toBe("warn");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkTcpConnectivity
// ──────────────────────────────────────────────────────────────────────────────
describe("checkTcpConnectivity", () => {
  it("returns pass when probe succeeds", async () => {
    const probe = jest.fn().mockResolvedValue(true);
    const result = await checkTcpConnectivity(
      "db:tcp",
      "localhost",
      5432,
      probe,
      "start postgres",
    );
    expect(result.status).toBe("pass");
    expect(probe).toHaveBeenCalledWith("localhost", 5432);
  });

  it("returns fail when probe fails", async () => {
    const probe = jest.fn().mockResolvedValue(false);
    const result = await checkTcpConnectivity(
      "db:tcp",
      "localhost",
      5432,
      probe,
      "start postgres",
    );
    expect(result.status).toBe("fail");
    expect(result.remediation).toBe("start postgres");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkHttpEndpoint
// ──────────────────────────────────────────────────────────────────────────────
describe("checkHttpEndpoint", () => {
  it("passes on a 200 response", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://horizon-testnet.stellar.org",
      probe,
      "check internet connection",
    );
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/HTTP 200/);
  });

  it("passes on a 404 (endpoint exists but not root)", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 404 });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://example.com",
      probe,
      "fix url",
    );
    expect(result.status).toBe("pass");
  });

  it("warns when probe fails (not blocks)", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: false });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://unreachable.example.com",
      probe,
      "check your internet connection",
    );
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeTruthy();
  });

  it("warns on 500 status", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 500 });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://down.example.com",
      probe,
      "server error",
    );
    expect(result.status).toBe("warn");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildReport
// ──────────────────────────────────────────────────────────────────────────────
describe("buildReport", () => {
  const checks: DiagnosticCheck[] = [
    { name: "a", status: "pass", detail: "ok" },
    { name: "b", status: "pass", detail: "ok" },
    { name: "c", status: "warn", detail: "warning", remediation: "fix it" },
    { name: "d", status: "fail", detail: "error", remediation: "required" },
    { name: "e", status: "skip", detail: "skipped" },
  ];

  it("counts all statuses correctly", () => {
    const report = buildReport(checks);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.warned).toBe(1);
    expect(report.skipped).toBe(1);
  });

  it("sets ok=false when any check failed", () => {
    const report = buildReport(checks);
    expect(report.ok).toBe(false);
  });

  it("sets ok=true when there are only passes and warnings", () => {
    const report = buildReport(checks.filter((c) => c.status !== "fail"));
    expect(report.ok).toBe(true);
  });

  it("includes all checks in the report", () => {
    const report = buildReport(checks);
    expect(report.checks).toHaveLength(checks.length);
  });
});
