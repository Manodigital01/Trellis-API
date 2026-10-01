import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PauseControlService } from "./pause-control.service";
import { PauseScope } from "./entities/pause-scope.entity";
import { PauseAuditLog } from "./entities/pause-audit-log.entity";
import { PausableScope } from "./dto/activate-pause.dto";

describe("PauseControlService", () => {
  let service: PauseControlService;
  let eventEmitter: EventEmitter2;

  const pauseStore: PauseScope[] = [];
  const auditStore: PauseAuditLog[] = [];

  const mockPauseRepo = {
    create: jest.fn((dto) => ({ id: `pause-${Date.now()}`, ...dto })),
    save: jest.fn((entity) => {
      const idx = pauseStore.findIndex((p) => p.id === entity.id);
      if (idx >= 0) {
        pauseStore[idx] = { ...entity };
      } else {
        pauseStore.push({ ...entity });
      }
      return Promise.resolve({ ...entity });
    }),
    findOne: jest.fn(({ where }) => {
      if (Array.isArray(where)) {
        // Find matching any condition
        const match = pauseStore.find((p) =>
          where.some(
            (w: any) =>
              (!w.scope || p.scope === w.scope) &&
              (!w.active || p.active === w.active),
          ),
        );
        return Promise.resolve(match ? { ...match } : null);
      }
      const match = pauseStore.find(
        (p) =>
          (!where.scope || p.scope === where.scope) &&
          (where.active === undefined || p.active === where.active),
      );
      return Promise.resolve(match ? { ...match } : null);
    }),
    find: jest.fn(({ where } = { where: undefined }) => {
      if (!where) return Promise.resolve([...pauseStore]);
      if (Array.isArray(where)) {
        const results = pauseStore.filter((p) =>
          where.some(
            (w: any) =>
              (!w.scope || p.scope === w.scope) &&
              (w.active === undefined || p.active === w.active),
          ),
        );
        return Promise.resolve(results.map((r) => ({ ...r })));
      }
      const results = pauseStore.filter(
        (p) =>
          (!where.scope || p.scope === where.scope) &&
          (where.active === undefined || p.active === where.active),
      );
      return Promise.resolve(results.map((r) => ({ ...r })));
    }),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([...pauseStore]),
    })),
  };

  const mockAuditRepo = {
    create: jest.fn((dto) => ({ id: `audit-${Date.now()}`, ...dto })),
    save: jest.fn((entity) => {
      auditStore.push({ ...entity });
      return Promise.resolve({ ...entity });
    }),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([...auditStore]),
    })),
  };

  beforeEach(async () => {
    pauseStore.length = 0;
    auditStore.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PauseControlService,
        { provide: getRepositoryToken(PauseScope), useValue: mockPauseRepo },
        { provide: getRepositoryToken(PauseAuditLog), useValue: mockAuditRepo },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<PauseControlService>(PauseControlService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    jest.clearAllMocks();
  });

  describe("activatePause", () => {
    it("should create an active pause", async () => {
      const pause = await service.activatePause({
        scope: PausableScope.TRADING,
        reason: "Market volatility detected",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      expect(pause.scope).toBe(PausableScope.TRADING);
      expect(pause.active).toBe(true);
      expect(pause.reason).toBe("Market volatility detected");
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "pause.activated",
        expect.objectContaining({ scope: PausableScope.TRADING }),
      );
    });

    it("should create audit log entry on activation", async () => {
      await service.activatePause({
        scope: PausableScope.PAYMENTS,
        reason: "Suspicious activity",
        actorId: "admin-2",
        actorRole: "ADMIN",
      });

      expect(mockAuditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "activate",
          actorId: "admin-2",
          reason: "Suspicious activity",
        }),
      );
    });

    it("should update existing pause idempotently", async () => {
      await service.activatePause({
        scope: PausableScope.TRADING,
        reason: "First reason",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      const updated = await service.activatePause({
        scope: PausableScope.TRADING,
        reason: "Updated reason",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      expect(updated.reason).toBe("Updated reason");
    });
  });

  describe("resumePause", () => {
    it("should deactivate a paused scope with audit trail", async () => {
      await service.activatePause({
        scope: PausableScope.TRADING,
        reason: "Emergency",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      const resumed = await service.resumePause(
        PausableScope.TRADING,
        "Issue resolved",
        "admin-1",
        "ADMIN",
      );

      expect(resumed).not.toBeNull();
      expect(resumed!.active).toBe(false);
      expect(resumed!.resumedBy).toBe("admin-1");
      expect(resumed!.resumeReason).toBe("Issue resolved");
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "pause.resumed",
        expect.objectContaining({ scope: PausableScope.TRADING }),
      );
    });

    it("should return null when no active pause exists", async () => {
      const result = await service.resumePause(
        PausableScope.ORACLE,
        "No reason",
        "admin-1",
        "ADMIN",
      );
      expect(result).toBeNull();
    });
  });

  describe("isOperationPaused", () => {
    it("should return true when scope is paused", async () => {
      await service.activatePause({
        scope: PausableScope.TRADING,
        reason: "Maintenance",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      const result = await service.isOperationPaused(PausableScope.TRADING);
      expect(result.paused).toBe(true);
      expect(result.reason).toBe("Maintenance");
    });

    it("should return false when scope is not paused", async () => {
      const result = await service.isOperationPaused(PausableScope.TRADING);
      expect(result.paused).toBe(false);
    });

    it("should detect 'all' scope pausing everything", async () => {
      await service.activatePause({
        scope: PausableScope.ALL,
        reason: "Full system pause",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      const result = await service.isOperationPaused(PausableScope.TRADING);
      expect(result.paused).toBe(true);
    });
  });

  describe("unrelated operations continue", () => {
    it("should not affect payments when trading is paused", async () => {
      await service.activatePause({
        scope: PausableScope.TRADING,
        reason: "Trading halt",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      const tradingResult = await service.isOperationPaused(PausableScope.TRADING);
      expect(tradingResult.paused).toBe(true);

      // Payments should not be affected - mock returns empty for payments scope
      mockPauseRepo.find.mockResolvedValueOnce([]);
      const paymentsResult = await service.isOperationPaused(PausableScope.PAYMENTS);
      expect(paymentsResult.paused).toBe(false);
    });
  });

  describe("auto-expiry", () => {
    it("should treat expired pause as inactive", async () => {
      const expiredPause: PauseScope = {
        id: "expired-1",
        scope: PausableScope.TRADING,
        active: true,
        reason: "Temporary halt",
        expiresAt: new Date(Date.now() - 60000), // expired 1 minute ago
        activatedBy: "admin-1",
        activatedByRole: "ADMIN",
        resumedBy: null,
        resumedByRole: null,
        resumeReason: null,
        environment: null,
        activatedAt: new Date(),
        resumedAt: null,
        updatedAt: new Date(),
      };
      mockPauseRepo.find.mockResolvedValueOnce([expiredPause]);

      const result = await service.isOperationPaused(PausableScope.TRADING);
      expect(result.paused).toBe(false);
      expect(mockPauseRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
    });
  });

  describe("audit log", () => {
    it("should create audit entries for activate and resume", async () => {
      await service.activatePause({
        scope: PausableScope.ORACLE,
        reason: "Oracle issue",
        actorId: "admin-1",
        actorRole: "ADMIN",
      });

      await service.resumePause(
        PausableScope.ORACLE,
        "Fixed",
        "admin-1",
        "ADMIN",
      );

      // Two audit entries: activate + resume
      expect(mockAuditRepo.save).toHaveBeenCalledTimes(2);
    });
  });

  describe("getActivePauses", () => {
    it("should return only active non-expired pauses", async () => {
      mockPauseRepo.find.mockResolvedValueOnce([
        {
          id: "p1",
          scope: PausableScope.TRADING,
          active: true,
          reason: "Test",
          expiresAt: null,
          activatedBy: "admin-1",
          activatedByRole: "ADMIN",
          resumedBy: null,
          resumedByRole: null,
          resumeReason: null,
          environment: null,
          activatedAt: new Date(),
          resumedAt: null,
          updatedAt: new Date(),
        } as PauseScope,
      ]);

      const pauses = await service.getActivePauses();
      expect(pauses.length).toBe(1);
    });
  });
});
