import { Test } from "@nestjs/testing";
import { HttpStatus } from "@nestjs/common";
import { DependencyHealthController } from "./dependency-health.controller";
import { DependencyHealthService } from "./dependency-health.service";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { DependencyReport, DependencyState } from "./dependency-health.types";
import { toDependencyHealthSummary } from "./dto/dependency-health.dto";

function report(status: DependencyState): DependencyReport {
  return {
    status,
    advisory: "healthy",
    generatedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 12,
    counts: { healthy: 1, degraded: 0, unavailable: 0, misconfigured: 0, disabled: 0 },
    criticalFindings: status === "healthy" ? [] : ["database"],
    advisoryFindings: [],
    checks: [
      {
        id: "database",
        label: "PostgreSQL (TypeORM DataSource)",
        kind: "service",
        criticality: "critical",
        state: status,
        detail: "SELECT 1 succeeded in 3ms",
        latencyMs: 3,
        target: "postgresql://trellis@db.internal:5432/trellis",
        verification: "database",
        configKeys: [{ key: "DATABASE_URL", configured: true }],
        remediation: "Start PostgreSQL",
      },
    ],
    networkProbesSkipped: false,
  };
}

function summaryFor(status: DependencyState) {
  return toDependencyHealthSummary(report(status));
}

describe("DependencyHealthController", () => {
  const service = {
    run: jest.fn(),
    getSummary: jest.fn(),
    invalidateCache: jest.fn(),
  };

  const response = () => {
    const res = { status: jest.fn() } as any;
    res.status.mockReturnValue(res);
    return res;
  };

  let controller: DependencyHealthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const allow = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [DependencyHealthController],
      providers: [{ provide: DependencyHealthService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue(allow)
      .overrideGuard(AdminTwoFactorGuard)
      .useValue(allow)
      .compile();
    controller = moduleRef.get(DependencyHealthController);
  });

  it("returns 200 while every critical dependency is healthy", async () => {
    service.getSummary.mockResolvedValue(summaryFor("healthy"));
    const res = response();

    await controller.getSummary(res);

    expect(res.status).not.toHaveBeenCalled();
    expect(service.getSummary).toHaveBeenCalledWith({ networkProbes: false });
  });

  it("returns 503 when a critical dependency is unavailable", async () => {
    service.getSummary.mockResolvedValue(summaryFor("unavailable"));
    const res = response();

    const result = await controller.getSummary(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.status).toBe("unavailable");
  });

  it("returns 503 when a critical dependency is misconfigured", async () => {
    service.getSummary.mockResolvedValue(summaryFor("misconfigured"));
    const res = response();

    await controller.getSummary(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it("does not fail the public probe for a degraded critical dependency", async () => {
    service.getSummary.mockResolvedValue(summaryFor("degraded"));
    const res = response();

    await controller.getSummary(res);

    expect(res.status).not.toHaveBeenCalled();
  });

  it("never asks for outbound probes on the public route", async () => {
    service.getSummary.mockResolvedValue(summaryFor("healthy"));

    await controller.getSummary(response());

    expect(service.getSummary).toHaveBeenCalledWith({ networkProbes: false });
  });

  it("returns the full report to maintainers and allows disabling probes", async () => {
    service.run.mockResolvedValue(report("healthy"));

    const result = await controller.getDiagnostics(undefined, "false");

    expect(service.run).toHaveBeenCalledWith({
      refresh: undefined,
      networkProbes: false,
    });
    expect(result.checks[0].configKeys).toEqual([
      { key: "DATABASE_URL", configured: true },
    ]);
    expect(service.invalidateCache).not.toHaveBeenCalled();
  });

  it("drops the cached report when a refresh is requested", async () => {
    service.run.mockResolvedValue(report("healthy"));

    await controller.getDiagnostics("true");

    expect(service.run).toHaveBeenCalledWith({
      refresh: true,
      networkProbes: undefined,
    });
    expect(service.invalidateCache).toHaveBeenCalled();
  });
});
