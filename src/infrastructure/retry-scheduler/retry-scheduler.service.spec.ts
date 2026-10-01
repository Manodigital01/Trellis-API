import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RetrySchedulerService } from "./retry-scheduler.service";
import {
  RetryOperation,
  RetryOperationStatus,
} from "./entities/retry-operation.entity";

describe("RetrySchedulerService", () => {
  let service: RetrySchedulerService;
  let eventEmitter: EventEmitter2;

  const mockOperations: RetryOperation[] = [];

  function cloneOp(op: any): any {
    const copy = { ...op };
    if (copy.nextRetryAt) copy.nextRetryAt = new Date(copy.nextRetryAt);
    if (copy.createdAt) copy.createdAt = new Date(copy.createdAt);
    if (copy.updatedAt) copy.updatedAt = new Date(copy.updatedAt);
    if (copy.completedAt) copy.completedAt = new Date(copy.completedAt);
    if (copy.deadLetteredAt) copy.deadLetteredAt = new Date(copy.deadLetteredAt);
    return copy;
  }

  const mockRepository = {
    create: jest.fn((dto) => ({ ...dto, id: "test-uuid" })),
    save: jest.fn((entity) => {
      const stored = cloneOp(entity);
      const idx = mockOperations.findIndex(
        (o) => o.operationId === entity.operationId,
      );
      if (idx >= 0) {
        mockOperations[idx] = stored;
      } else {
        mockOperations.push(stored);
      }
      return Promise.resolve(cloneOp(entity));
    }),
    findOne: jest.fn(({ where }) => {
      const match = mockOperations.find((o) => {
        if (where.operationId && where.status) {
          return (
            o.operationId === where.operationId && o.status === where.status
          );
        }
        return o.operationId === where.operationId;
      });
      return Promise.resolve(match ? cloneOp(match) : null);
    }),
    find: jest.fn(() => Promise.resolve(mockOperations.map(cloneOp))),
    findAndCount: jest.fn(({ where }) => {
      const filtered = mockOperations.filter(
        (o) => o.status === where.status,
      );
      return Promise.resolve([filtered.map(cloneOp), filtered.length]);
    }),
  };

  beforeEach(async () => {
    mockOperations.length = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetrySchedulerService,
        {
          provide: getRepositoryToken(RetryOperation),
          useValue: mockRepository,
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RetrySchedulerService>(RetrySchedulerService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);

    jest.clearAllMocks();
  });

  describe("schedule", () => {
    it("should create a pending retry operation", async () => {
      const result = await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-1",
        payload: { url: "https://example.com" },
        maxAttempts: 5,
        backoffMs: 2000,
      });

      expect(result.operationId).toBe("op-1");
      expect(result.status).toBe(RetryOperationStatus.PENDING);
      expect(result.maxAttempts).toBe(5);
      expect(result.backoffMs).toBe(2000);
      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
    });
  });

  describe("markSucceeded", () => {
    it("should mark operation as succeeded and emit event", async () => {
      await service.schedule({
        operationType: "email.send",
        operationId: "op-2",
        payload: { to: "user@example.com" },
      });

      const result = await service.markSucceeded("op-2");

      expect(result).not.toBeNull();
      expect(result!.status).toBe(RetryOperationStatus.SUCCEEDED);
      expect(result!.completedAt).toBeDefined();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.succeeded",
        expect.objectContaining({ operationId: "op-2" }),
      );
    });

    it("should return null for unknown operation", async () => {
      const result = await service.markSucceeded("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("success after retry", () => {
    it("should succeed after one failure and retry", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-retry-1",
        payload: { data: "test" },
        maxAttempts: 3,
      });

      // First attempt fails
      const failed = await service.markFailed(
        "op-retry-1",
        "Connection timeout",
      );
      expect(failed!.status).toBe(RetryOperationStatus.PENDING);
      expect(failed!.attempts).toBe(1);
      expect(failed!.nextRetryAt).toBeDefined();

      // Second attempt succeeds
      const succeeded = await service.markSucceeded("op-retry-1");
      expect(succeeded!.status).toBe(RetryOperationStatus.SUCCEEDED);
      expect(succeeded!.completedAt).toBeDefined();
    });
  });

  describe("retry exhaustion", () => {
    it("should move to dead letter after maxAttempts failures", async () => {
      await service.schedule({
        operationType: "payment.submit",
        operationId: "op-exhaust-1",
        payload: { amount: 100 },
        maxAttempts: 2,
      });

      // First failure
      await service.markFailed("op-exhaust-1", "Network error");

      // Second failure - should exhaust retries
      const deadLettered = await service.markFailed(
        "op-exhaust-1",
        "Network error again",
      );
      expect(deadLettered!.status).toBe(RetryOperationStatus.DEAD_LETTER);
      expect(deadLettered!.deadLetteredAt).toBeDefined();
      expect(deadLettered!.nextRetryAt).toBeNull();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.dead_letter",
        expect.objectContaining({
          operationId: "op-exhaust-1",
          reason: expect.stringContaining("Exhausted"),
        }),
      );
    });
  });

  describe("non-retryable failure", () => {
    it("should immediately dead-letter non-retryable failures", async () => {
      await service.schedule({
        operationType: "payment.submit",
        operationId: "op-nonretry-1",
        payload: { amount: 100 },
        maxAttempts: 5,
      });

      const result = await service.markFailed(
        "op-nonretry-1",
        "Invalid payload - cannot retry",
        false,
      );

      expect(result!.status).toBe(RetryOperationStatus.DEAD_LETTER);
      expect(result!.deadLetteredAt).toBeDefined();
      expect(result!.attempts).toBe(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "retry.dead_letter",
        expect.objectContaining({
          operationId: "op-nonretry-1",
          reason: "Non-retryable failure",
        }),
      );
    });

    it("should immediately dead-letter operations marked non-retryable at schedule time", async () => {
      await service.schedule({
        operationType: "data.validate",
        operationId: "op-nonretry-2",
        payload: { data: "test" },
        retryable: false,
      });

      const result = await service.markFailed(
        "op-nonretry-2",
        "Validation failed",
      );

      expect(result!.status).toBe(RetryOperationStatus.DEAD_LETTER);
    });
  });

  describe("backoff calculation", () => {
    it("should apply exponential backoff with cap", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-backoff-1",
        payload: {},
        maxAttempts: 10,
        backoffMs: 1000,
        backoffMultiplier: 2,
        maxBackoffMs: 10000,
      });

      // First failure: delay ~1000ms
      const fail1 = await service.markFailed("op-backoff-1", "err");
      const delay1 =
        fail1!.nextRetryAt!.getTime() - Date.now();
      expect(delay1).toBeGreaterThan(800); // 1000 - 10% jitter
      expect(delay1).toBeLessThan(1200); // 1000 + 10% jitter

      // Second failure: delay ~2000ms
      const fail2 = await service.markFailed("op-backoff-1", "err");
      const delay2 =
        fail2!.nextRetryAt!.getTime() - Date.now();
      expect(delay2).toBeGreaterThan(1600); // 2000 - 10% jitter
      expect(delay2).toBeLessThan(2400); // 2000 + 10% jitter

      // After several failures, should cap at maxBackoffMs
      await service.markFailed("op-backoff-1", "err"); // 4000ms
      await service.markFailed("op-backoff-1", "err"); // 8000ms
      const fail5 = await service.markFailed("op-backoff-1", "err"); // should cap at 10000ms
      const delay5 =
        fail5!.nextRetryAt!.getTime() - Date.now();
      expect(delay5).toBeLessThanOrEqual(11000); // 10000 + 10% jitter
    });
  });

  describe("getDeadLetters", () => {
    it("should return dead-lettered operations", async () => {
      await service.schedule({
        operationType: "email.send",
        operationId: "op-dl-1",
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed("op-dl-1", "SMTP error");

      const { items, total } = await service.getDeadLetters();
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((o) => o.status === RetryOperationStatus.DEAD_LETTER)).toBe(true);
    });
  });

  describe("retryDeadLetter", () => {
    it("should re-queue a dead-lettered operation", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-dl-retry-1",
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed("op-dl-retry-1", "timeout");

      const retried = await service.retryDeadLetter("op-dl-retry-1", 3);
      expect(retried).not.toBeNull();
      expect(retried!.status).toBe(RetryOperationStatus.PENDING);
      expect(retried!.attempts).toBe(0);
      expect(retried!.maxAttempts).toBe(3);
      expect(retried!.deadLetteredAt).toBeNull();
    });

    it("should return null for non-dead-lettered operation", async () => {
      await service.schedule({
        operationType: "email.send",
        operationId: "op-dl-retry-2",
        payload: {},
      });

      const result = await service.retryDeadLetter("op-dl-retry-2");
      expect(result).toBeNull();
    });
  });

  describe("getMetrics", () => {
    it("should return correct metrics", async () => {
      await service.schedule({
        operationType: "webhook.delivery",
        operationId: "op-m1",
        payload: {},
      });
      await service.markSucceeded("op-m1");

      await service.schedule({
        operationType: "email.send",
        operationId: "op-m2",
        payload: {},
        maxAttempts: 1,
      });
      await service.markFailed("op-m2", "error");

      const metrics = await service.getMetrics();
      expect(metrics.total).toBeGreaterThanOrEqual(2);
      expect(metrics.succeeded).toBeGreaterThanOrEqual(1);
      expect(metrics.deadLettered).toBeGreaterThanOrEqual(1);
      expect(metrics.successRate).toBeGreaterThan(0);
      expect(metrics.byType["webhook.delivery"]).toBeDefined();
      expect(metrics.byType["email.send"]).toBeDefined();
    });
  });
});
