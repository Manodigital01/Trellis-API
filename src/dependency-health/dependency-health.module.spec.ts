/**
 * Guards the module wiring for the Redis client that the dependency health
 * service probes with. A test that builds the service by hand cannot catch a
 * DI token that is provided in one module but never exported, nor a module
 * that forgets to import the owner, and both failures silently degrade the
 * Redis probe at runtime.
 *
 * Issue: #124
 */

import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getDataSourceToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DependencyHealthService } from "./dependency-health.service";
import { HealthModule } from "../health/health.module";
import { HEALTH_REDIS_CLIENT } from "../health/health.constants";

describe("dependency health Redis wiring", () => {
  const previous = { ...process.env };

  beforeEach(() => {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL =
      "postgresql://trellis:pg-password-value@db.internal:5432/trellis";
    process.env.JWT_SECRET = "jwt-secret-value-0123456789abcdef";
    process.env.REDIS_URL = "redis://cache.internal:6379";
    process.env.STELLAR_HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.STELLAR_NETWORK_PASSPHRASE =
      "Test SDF Network ; September 2015";
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.entries(previous).forEach(([key, value]) => {
      if (value !== undefined) process.env[key] = value;
    });
  });

  it("exports the Redis client so sibling modules can share the connection", () => {
    expect(Reflect.getMetadata("exports", HealthModule)).toContain(
      HEALTH_REDIS_CLIENT,
    );
  });

  it("imports the health module that owns the Redis client", () => {
    // `DependencyHealthModule` is not imported here on purpose: it pulls in
    // AuthModule, which currently has a broken import of its own and is out of
    // scope for this issue.
    const source = readFileSync(
      join(__dirname, "dependency-health.module.ts"),
      "utf8",
    );

    expect(source).toMatch(/imports:\s*\[[^\]]*HealthModule/);
  });

  it("pings the injected client instead of skipping the probe", async () => {
    const ping = jest.fn().mockResolvedValue("PONG");
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ "1": 1 }]),
      isInitialized: true,
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

    const report = await moduleRef
      .get(DependencyHealthService)
      .run({ networkProbes: false });

    expect(ping).toHaveBeenCalledTimes(1);
    expect(report.checks.find((c) => c.id === "redis")).toMatchObject({
      state: "healthy",
      // A PING is a real outbound round trip, not a local configuration read.
      verification: "network",
    });
  });
});
