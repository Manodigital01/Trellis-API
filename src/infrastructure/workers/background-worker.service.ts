import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { JobStatus, JobPriority, WorkerJob, RetryPolicy, DEFAULT_RETRY_POLICY, WorkerJobPayload } from "./worker.interface";
import { JobStatus, WorkerJob, RetryPolicy, DEFAULT_RETRY_POLICY, WorkerJobPayload, JobPriority } from "./worker.interface";
import {
  withTraceContext,
  runTracedJob,
  extractJobContext,
} from "src/observability/async-job-tracing";

@Injectable()
export class BackgroundWorkerService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundWorkerService.name);
  private readonly jobStore = new Map<string, WorkerJob>();
  private readonly policies = new Map<string, RetryPolicy>();

  constructor(@InjectQueue("background-jobs") private readonly queue: Queue) {
    // Register default policies eagerly so they exist even when the module
    // is instantiated outside the Nest lifecycle (e.g. in unit tests).
    this.registerDefaultPolicies();
  }

  onModuleInit() {
    this.registerDefaultPolicies();
    this.setupEventListeners();
  }

  private registerDefaultPolicies() {
    const defaults: Record<string, Partial<RetryPolicy>> = {
      "webhook.delivery": { maxAttempts: 5, backoffMs: 2000, backoffMultiplier: 2, maxBackoffMs: 60000 },
      "email.send": { maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 30000 },
      "data.export": { maxAttempts: 2, backoffMs: 5000, maxBackoffMs: 60000 },
      "reconciliation.sync": { maxAttempts: 4, backoffMs: 3000, backoffMultiplier: 1.5, maxBackoffMs: 120000 },
    };

    for (const [type, policy] of Object.entries(defaults)) {
      this.policies.set(type, { ...DEFAULT_RETRY_POLICY, ...policy });
    }
  }

  private setupEventListeners() {
    this.queue.on("completed", (job) => {
      this.updateJobStatus(job.id.toString(), JobStatus.COMPLETED, { result: job.returnvalue });
      this.logger.log(`Job ${job.id} completed`);
    });

    this.queue.on("failed", (job, err) => {
      const workerJob = this.jobStore.get(job.id.toString());
      const attempts = job.attemptsMade;
      const maxAttempts = workerJob?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;

      if (attempts >= maxAttempts) {
        this.updateJobStatus(job.id.toString(), JobStatus.DEAD_LETTER, { error: err.message });
        this.logger.warn(`Job ${job.id} moved to dead-letter queue after ${attempts} attempts`);
      } else {
        this.updateJobStatus(job.id.toString(), JobStatus.FAILED, { error: err.message });
        this.logger.error(`Job ${job.id} failed (attempt ${attempts}/${maxAttempts}): ${err.message}`);
      }
    });

    this.queue.on("progress", (job, progress) => {
      this.logger.debug(`Job ${job.id} progress: ${progress}%`);
    });
  }

  async enqueue<T>(payload: WorkerJobPayload): Promise<WorkerJob> {
    const type = payload.type;
    const policy = this.policies.get(type) || DEFAULT_RETRY_POLICY;
    const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date();

    const job: WorkerJob = {
      id,
      type,
      payload: payload.payload,
      priority: payload.priority || JobPriority.NORMAL,
      attempts: 0,
      maxAttempts: policy.maxAttempts,
      backoffMs: policy.backoffMs,
      delayMs: payload.delayMs,
      status: JobStatus.PENDING,
      createdAt: now,
      updatedAt: now,
      correlationId: payload.correlationId,
      schemaVersion: "1.0.0",
    };

    this.jobStore.set(id, job);

    const bullJob = await this.queue.add(
      type,
      // Stamp the active W3C trace context so the worker-side processing
      // span is parented to the originating HTTP request span.
      withTraceContext({ ...payload.payload, _jobId: id, _schemaVersion: "1.0.0" }),
      {
        jobId: id,
        priority: this.mapPriority(payload.priority || JobPriority.NORMAL),
        attempts: policy.maxAttempts,
        backoff: {
          type: "exponential",
          delay: policy.backoffMs,
        },
        delay: payload.delayMs || 0,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );

    this.logger.log(`Enqueued job ${id} of type ${type}`);
    return job;
  }
  async getJob(id: string): Promise<WorkerJob | undefined> {
    return this.jobStore.get(id);
  }

  async listJobs(status?: JobStatus, limit = 50): Promise<WorkerJob[]> {
    let jobs = Array.from(this.jobStore.values());
    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
    return jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }

  async retryJob(id: string): Promise<WorkerJob | null> {
    const job = this.jobStore.get(id);
    if (!job) return null;

    if (job.status !== JobStatus.FAILED && job.status !== JobStatus.DEAD_LETTER) {
      this.logger.warn(`Cannot retry job ${id}: status is ${job.status}`);
      return null;
    }

    const policy = this.policies.get(job.type) || DEFAULT_RETRY_POLICY;
    job.attempts = 0;
    job.status = JobStatus.PENDING;
    job.updatedAt = new Date();
    job.error = undefined;

    await this.queue.add(
      job.type,
      withTraceContext(
        { ...job.payload, _jobId: job.id, _schemaVersion: job.schemaVersion, _retry: true },
        // Preserve the ORIGINAL request trace across retries.
        extractJobContext({ __trace: (job.payload as { __trace?: object })?.__trace }) as never,
      ),
      {
        jobId: job.id,
        priority: this.mapPriority(job.priority),
        attempts: policy.maxAttempts,
        backoff: { type: "exponential", delay: job.backoffMs },
        delay: 0,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );

    this.updateJobStatus(id, JobStatus.ACTIVE);
    this.logger.log(`Retrying job ${id}`);
    return job;
  }

  async cancelJob(id: string): Promise<boolean> {
    const job = this.jobStore.get(id);
    if (!job || job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) {
      return false;
    }

    const bullJob = await this.queue.getJob(job.id);
    if (bullJob) {
      await bullJob.remove();
    }
    await (this.queue as any).remove(job.id);
    job.status = JobStatus.FAILED;
    job.updatedAt = new Date();
    job.error = "Cancelled by user";
    return true;
  }

  async getMetrics() {
    const jobs = Array.from(this.jobStore.values());
    const total = jobs.length;
    const completed = jobs.filter((j) => j.status === JobStatus.COMPLETED).length;
    const failed = jobs.filter((j) => j.status === JobStatus.FAILED).length;
    const deadLettered = jobs.filter((j) => j.status === JobStatus.DEAD_LETTER).length;
    const pending = jobs.filter((j) => j.status === JobStatus.PENDING || j.status === JobStatus.ACTIVE).length;

    return {
      total,
      completed,
      failed,
      deadLettered,
      pending,
      successRate: total > 0 ? (completed / total) * 100 : 0,
      byType: jobs.reduce<Record<string, number>>((acc, j) => { acc[j.type] = (acc[j.type] || 0) + 1; return acc; }, {}),
    };
  }

  private updateJobStatus(id: string, status: JobStatus, updates: Partial<WorkerJob> = {}) {
    const job = this.jobStore.get(id);
    if (!job) return;
    job.status = status;
    job.updatedAt = new Date();
    if (status === JobStatus.COMPLETED) job.completedAt = new Date();
    if (status === JobStatus.FAILED || status === JobStatus.DEAD_LETTER) job.failedAt = new Date();
    Object.assign(job, updates);
  }

  private mapPriority(priority: JobPriority): number {
    const map: Record<JobPriority, number> = {
      [JobPriority.LOW]: -10,
      [JobPriority.NORMAL]: 0,
      [JobPriority.HIGH]: 10,
      [JobPriority.CRITICAL]: 20,
    };
    return map[priority] || 0;
  }
}
