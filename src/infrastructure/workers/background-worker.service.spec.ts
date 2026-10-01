import { Test, TestingModule } from "@nestjs/testing";
import { BackgroundWorkerService } from "./background-worker.service";
import { JobStatus, JobPriority, DEFAULT_RETRY_POLICY } from "./worker.interface";

describe("BackgroundWorkerService", () => {
  let service: BackgroundWorkerService;
  let mockQueue: any;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: "job_123" }),
      remove: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) }),
      on: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackgroundWorkerService,
        {
          provide: "BullQueue_background-jobs",
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<BackgroundWorkerService>(BackgroundWorkerService);
    service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("enqueue", () => {
    it("should enqueue a job with default options", async () => {
      const payload = {
        type: "test.job",
        payload: { data: "test" },
      };

      const job = await service.enqueue(payload);

      expect(job).toBeDefined();
      expect(job.type).toBe("test.job");
      expect(job.status).toBe(JobStatus.PENDING);
      expect(job.schemaVersion).toBe("1.0.0");
      expect(mockQueue.add).toHaveBeenCalledWith(
        "test.job",
        expect.objectContaining({ data: "test" }),
        expect.objectContaining({
          attempts: DEFAULT_RETRY_POLICY.maxAttempts,
          priority: 0,
        }),
      );
    });

    it("should enqueue a job with custom priority", async () => {
      const payload = {
        type: "test.job",
        payload: { data: "test" },
        priority: JobPriority.HIGH,
      };

      const job = await service.enqueue(payload);

      expect(job.priority).toBe(JobPriority.HIGH);
      expect(mockQueue.add).toHaveBeenCalledWith(
        "test.job",
        expect.any(Object),
        expect.objectContaining({ priority: 10 }),
      );
    });

    it("should enqueue a job with custom retry policy", async () => {
      const payload = {
        type: "webhook.delivery",
        payload: { url: "https://example.com" },
      };

      const job = await service.enqueue(payload);

      expect(job.maxAttempts).toBe(5);
      expect(mockQueue.add).toHaveBeenCalledWith(
        "webhook.delivery",
        expect.any(Object),
        expect.objectContaining({ attempts: 5 }),
      );
    });

    it("should include correlation ID when provided", async () => {
      const correlationId = "corr_123";
      const payload = {
        type: "test.job",
        payload: { data: "test" },
        correlationId,
      };

      const job = await service.enqueue(payload);

      expect(job.correlationId).toBe(correlationId);
    });

    it("should assign a unique ID to each job", async () => {
      const job1 = await service.enqueue({ type: "test.job", payload: {} });
      const job2 = await service.enqueue({ type: "test.job", payload: {} });

      expect(job1.id).not.toBe(job2.id);
    });
  });

  describe("getJob", () => {
    it("should return a job by ID", async () => {
      const payload = { type: "test.job", payload: { data: "test" } };
      const job = await service.enqueue(payload);

      const retrieved = await service.getJob(job.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(job.id);
    });

    it("should return undefined for non-existent job", async () => {
      const retrieved = await service.getJob("non_existent_id");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("listJobs", () => {
    it("should return all jobs when no status filter is provided", async () => {
      await service.enqueue({ type: "test.job", payload: { data: "test1" } });
      await service.enqueue({ type: "test.job", payload: { data: "test2" } });

      const jobs = await service.listJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter jobs by status", async () => {
      await service.enqueue({ type: "test.job", payload: { data: "test" } });

      const allJobs = await service.listJobs();
      const pendingJobs = await service.listJobs(JobStatus.PENDING);

      expect(pendingJobs.length).toBeLessThanOrEqual(allJobs.length);
    });

    it("should respect the limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await service.enqueue({ type: "test.job", payload: { data: `test${i}` } });
      }

      const jobs = await service.listJobs(undefined, 5);
      expect(jobs.length).toBeLessThanOrEqual(5);
    });
  });

  describe("retryJob", () => {
    it("should retry a failed job", async () => {
      const payload = { type: "test.job", payload: { data: "test" } };
      const job = await service.enqueue(payload);

      // Simulate failure
      (service as any).updateJobStatus(job.id, JobStatus.FAILED, { error: "Test error" });

      const retried = await service.retryJob(job.id);
      expect(retried).toBeDefined();
      expect(retried!.status).toBe(JobStatus.ACTIVE);
      expect(retried!.error).toBeUndefined();
    });

    it("should return null for non-existent job", async () => {
      const retried = await service.retryJob("non_existent_id");
      expect(retried).toBeNull();
    });

    it("should not retry a completed job", async () => {
      const payload = { type: "test.job", payload: { data: "test" } };
      const job = await service.enqueue(payload);

      (service as any).updateJobStatus(job.id, JobStatus.COMPLETED);

      const retried = await service.retryJob(job.id);
      expect(retried).toBeNull();
    });
  });

  describe("cancelJob", () => {
    it("should cancel a pending job", async () => {
      const payload = { type: "test.job", payload: { data: "test" } };
      const job = await service.enqueue(payload);

      const cancelled = await service.cancelJob(job.id);
      expect(cancelled).toBe(true);
      expect(mockQueue.getJob).toHaveBeenCalledWith(job.id);
    });

    it("should not cancel a completed job", async () => {
      const payload = { type: "test.job", payload: { data: "test" } };
      const job = await service.enqueue(payload);

      (service as any).updateJobStatus(job.id, JobStatus.COMPLETED);
      const cancelled = await service.cancelJob(job.id);
      expect(cancelled).toBe(false);
    });
  });

  describe("getMetrics", () => {
    it("should return job metrics", async () => {
      await service.enqueue({ type: "test.job", payload: { data: "test1" } });
      await service.enqueue({ type: "test.job", payload: { data: "test2" } });

      const metrics = await service.getMetrics();
      expect(metrics.total).toBeGreaterThanOrEqual(2);
      expect(metrics.successRate).toBeGreaterThanOrEqual(0);
      expect(metrics.byType).toBeDefined();
    });
  });
});
