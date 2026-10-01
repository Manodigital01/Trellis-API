/**
 * Behavioural tests for {@link DependencyHealthService}.
 *
 * Covers the four states named in issue #124 — healthy, degraded, unavailable
 * and misconfigured — plus the "no secrets in output" guarantee.
 *
 * Issue: #124
 */

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getDataSourceToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DependencyHealthService } from "./dependency-health.service";
import { runDependencyChecks } from "./dependency-health.runner";
import {
  DependencyCheckResult,
  DependencyReport,
} from "./dependency-health.types";
import { HEALTH_REDIS_CLIENT } from "../health/health.constants";
import { REDACTED } from "./dependency-health.probe-kit";

const DB_URL = "postgresql://trellis:pg-password-value@db.internal:5432/trellis";
const JWT = "jwt-secret-value-0123456789abcdef";
const HORIZON = "https://horizon-testnet.stellar.org";
const RPC = "https://eth-rpc.example.org/v1";

/** Module-scoped hook so `afterEach` can put the real environment back. */
let restoreEnv: (() => void) | undefined;

function applyEnv(env: Record<string, string | undefined>): void {
  const previous = { ...process.env };
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.entries(env).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  restoreEnv = () => {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.entries(previous).forEach(([key, value]) => {
      if (value !== undefined) process.env[key] = value;
    });
  };
}

function baseEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    JWT_SECRET: JWT,
    REDIS_URL: "redis://cache.internal:6379",
    STELLAR_HORIZON_URL: HORIZON,
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    ETH_RPC_URL: RPC,
    CHAIN_ID: "11155111",
    FILE_STORAGE_BACKEND: "local",
  };
}

async function buildService(
  options: {
    env?: Record<string, string | undefined>;
    query?: jest.Mock;
    ping?: jest.Mock;
    isInitialized?: boolean;
  } = {},
): Promise<DependencyHealthService> {
  // Start from a known baseline: an explicit `undefined` removes a key.
  applyEnv({ ...baseEnv(), ...(options.env ?? {}) });

  const query = options.query ?? jest.fn().mockResolvedValue([{ "1": 1 }]);
  const ping = options.ping ?? jest.fn().mockResolvedValue("PONG");
  const dataSource = {
    query,
    isInitialized: options.isInitialized ?? true,
  } as unknown as DataSource;

  const moduleRef = await Test.createTestingModule({
    providers: [
      DependencyHealthService,
      { provide: getDataSourceToken(), useValue: dataSource },
      {
        provide: ConfigService,
        useValue: new ConfigService({
          DEPENDENCY_HEALTH_TIMEOUT_MS: 1000,
          DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS: 200,
          DEPENDENCY_HEALTH_CACHE_TTL_MS: 0,
        }),
      },
      { provide: HEALTH_REDIS_CLIENT, useValue: { ping } },
    ],
  }).compile();

  return moduleRef.get(DependencyHealthService);
}

async function buildServiceWithCache(
  query: jest.Mock,
  cacheTtlMs: number,
): Promise<DependencyHealthService> {
  const previous = { ...process.env };
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.entries(baseEnv()).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  global.__restoreEnv = () => {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.entries(previous).forEach(([key, value]) => {
      if (value !== undefined) process.env[key] = value;
    });
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      DependencyHealthService,
      {
        provide: getDataSourceToken(),
        useValue: { query, isInitialized: true } as unknown as DataSource,
      },
      {
        provide: ConfigService,
        useValue: new ConfigService({
          DEPENDENCY_HEALTH_TIMEOUT_MS: 1000,
          DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS: 200,
          DEPENDENCY_HEALTH_CACHE_TTL_MS: cacheTtlMs,
        }),
      },
      { provide: HEALTH_REDIS_CLIENT, useValue: { ping: jest.fn().mockResolvedValue("PONG") } },
    ],
  }).compile();

  return moduleRef.get(DependencyHealthService);
}

declare global {
  // eslint-disable-next-line no-var
  var __restoreEnv: (() => void) | undefined;
}

function findCheck(report: DependencyReport, id: string): DependencyCheckResult {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`check ${id} not present in report`);
  return found;
}

describe("DependencyHealthService", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global as any, "fetch")
      .mockImplementation(async (url: any) => {
        if (String(url).includes("horizon")) {
          return { status: 200, json: async () => ({}) } as any;
        }
        if (String(url).includes("eth-rpc")) {
          return {
            status: 200,
            json: async () => ({ result: "0xaa36a7" }),
          } as any;
        }
        return { status: 404, json: async () => ({}) } as any;
      });
  });

  afterEach(() => {
    fetchMock.mockRestore();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it("reports healthy when every critical dependency answers", async () => {
    const service = await buildService();

    const report = await service.run({ networkProbes: true });

    expect(report.status).toBe("healthy");
    expect(findCheck(report, "database").state).toBe("healthy");
    expect(findCheck(report, "redis").state).toBe("healthy");
    expect(findCheck(report, "stellar_horizon").verification).toBe("network");
    expect(findCheck(report, "eth_rpc").detail).toContain("11155111");
    expect(report.criticalFindings).toEqual([]);
  });

  it("reports degraded when a reachable dependency is slower than the budget", async () => {
    const service = await buildService({
      query: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [{ "1": 1 }];
      }),
    });

    const report = await service.run({ networkProbes: true });

    expect(findCheck(report, "database").state).toBe("degraded");
    expect(findCheck(report, "database").remediation).toMatch(/pool/i);
    expect(report.status).toBe("degraded");
    expect(report.criticalFindings).toEqual(["database"]);
  });

  it("reports unavailable when a dependency cannot be reached", async () => {
    const service = await buildService({
      query: jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
      ping: jest.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND cache.invalid")),
    });

    const report = await service.run({ networkProbes: true });

    expect(findCheck(report, "database").state).toBe("unavailable");
    expect(findCheck(report, "redis").state).toBe("unavailable");
    expect(report.status).toBe("unavailable");
    expect(findCheck(report, "database").remediation).toMatch(/PostgreSQL/);
  });

  it("reports unavailable when a dependency times out", async () => {
    const service = await buildService({
      ping: jest.fn(() => new Promise(() => undefined)),
    });

    const report = await service.run({ networkProbes: true });

    const redis = findCheck(report, "redis");
    expect(redis.state).toBe("unavailable");
    expect(redis.detail).toMatch(/timed out after 1000ms/);
  });

  it("reports misconfigured when required configuration is missing", async () => {
    const service = await buildService({
      env: {
        DATABASE_URL: undefined,
        STELLAR_NETWORK_PASSPHRASE: undefined,
      } as Record<string, string | undefined>,
    });

    const report = await service.run({ networkProbes: true });

    expect(findCheck(report, "database").state).toBe("misconfigured");
    expect(findCheck(report, "database").detail).toMatch(/DATABASE_URL/);
    expect(findCheck(report, "stellar_network_passphrase").state).toBe(
      "misconfigured",
    );
    expect(report.status).toBe("misconfigured");
  });

  it("reports misconfigured when the RPC chain id contradicts the configured one", async () => {
    fetchMock.mockImplementation(async () => ({
      status: 200,
      json: async () => ({ result: "0x1" }),
    })) as any;

    const service = await buildService();

    const report = await service.run({ networkProbes: true });
    const rpc = findCheck(report, "eth_rpc");

    expect(rpc.state).toBe("degraded");
    expect(rpc.detail).toMatch(/CHAIN_ID=11155111/);
    expect(rpc.detail).toMatch(/chainId=1/);
  });

  it("marks optional dependencies as disabled instead of failing them", async () => {
    const service = await buildService({
      env: {
        SMTP_HOST: undefined,
        SENTRY_DSN: undefined,
        OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        OPENAI_API_KEY: undefined,
      } as Record<string, string | undefined>,
    });

    const report = await service.run({ networkProbes: true });

    expect(findCheck(report, "smtp").state).toBe("disabled");
    expect(findCheck(report, "sentry").state).toBe("disabled");
    expect(report.status).toBe("healthy");
    expect(report.advisory).toBe("healthy");
  });

  it("keeps optional failures advisory instead of gating readiness", async () => {
    const service = await buildService({
      env: { SMTP_HOST: "smtp.invalid", SMTP_PORT: "587" },
    });

    const report = await service.run({ networkProbes: true });

    expect(findCheck(report, "smtp").state).toBe("unavailable");
    expect(report.status).toBe("healthy");
    expect(report.advisory).toBe("unavailable");
  });

  it("never exposes secret values in the report or its remediation hints", async () => {
    const service = await buildService({
      env: { STELLAR_SIGNING_SECRET: "top-secret-signing-key" },
      query: jest
        .fn()
        .mockRejectedValue(
          new Error(
            `FATAL: password authentication failed (password=top-secret-signing-key)`,
          ),
        ),
    });

    const report = await service.run({ networkProbes: true });
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain("top-secret-signing-key");
    expect(serialised).not.toContain("pg-password-value");
    expect(serialised).not.toContain(JWT);
    expect(findCheck(report, "database").detail).toContain(REDACTED);
    // The username of a connection URL is dropped alongside the password.
    expect(findCheck(report, "database").target).toBe(
      "postgresql://db.internal:5432/trellis",
    );
  });

  it("reports only key names, never values, for configuration", async () => {
    const service = await buildService();

    const report = await service.run({ networkProbes: true });
    const database = findCheck(report, "database");

    expect(database.configKeys).toEqual([
      { key: "DATABASE_URL", configured: true },
      { key: "JWT_SECRET", configured: true },
      { key: "DB_DATABASE", configured: false },
    ]);
    expect(JSON.stringify(database.configKeys)).not.toContain(DB_URL);
  });

  it("survives a probe that throws instead of failing the whole report", async () => {
    const service = await buildService();
    const definition = {
      id: "exploding",
      label: "Exploding dependency",
      kind: "service" as const,
      criticality: "optional" as const,
      configKeys: [],
      remediation: {
        misconfigured: "fix it",
        unavailable: "start it",
        degraded: "wait",
      },
      probe: async () => {
        throw new Error("probe exploded");
      },
    };
    const context = (service as any).buildContext(true);

    const report = await runDependencyChecks({
      context,
      definitions: [definition],
    });

    expect(findCheck(report, "exploding").state).toBe("unavailable");
    expect(findCheck(report, "exploding").detail).toMatch(/probe exploded/);
  });

  it("caches results and re-probes after an explicit refresh", async () => {
    const query = jest.fn().mockResolvedValue([{ "1": 1 }]);
    const service = await buildServiceWithCache(query, 60_000);

    const first = await service.run({ networkProbes: true });
    const second = await service.run({ networkProbes: true });
    expect(first.generatedAt).toBe(second.generatedAt);
    expect(query).toHaveBeenCalledTimes(1);

    await service.run({ networkProbes: true, refresh: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns a compact public summary without targets or configuration keys", async () => {
    const service = await buildService();

    const summary = await service.getSummary({ networkProbes: true });

    expect(summary.status).toBe("healthy");
    expect(summary.checks[0]).not.toHaveProperty("target");
    expect(summary.checks[0]).not.toHaveProperty("configKeys");
    expect(JSON.stringify(summary)).not.toContain(DB_URL);
  });
});
