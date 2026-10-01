import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThanOrEqual, In } from "typeorm";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  RetryOperation,
  RetryOperationStatus,
} from "./entities/retry-operation.entity";
import { ScheduleRetryDto } from "./dto/schedule-retry.dto";

export interface ScheduleRetryOpts {
  operationType: string;
  operationId: string;
  payload: any;
  maxAttempts?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  retryable?: boolean;
  correlationId?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class RetrySchedulerService {
  private readonly logger = new Logger(RetrySchedulerService.name);

  constructor(
    @InjectRepository(RetryOperation)
    private readonly retryRepo: Repository<RetryOperation>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async schedule(opts: ScheduleRetryOpts): Promise<RetryOperation> {
    const operation = this.retryRepo.create({
      operationType: opts.operationType,
      operationId: opts.operationId,
      payload: opts.payload,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3,
      backoffMs: opts.backoffMs ?? 1000,
      backoffMultiplier: opts.backoffMultiplier ?? 2,
      maxBackoffMs: opts.maxBackoffMs ?? 60000,
      retryable: opts.retryable ?? true,
      correlationId: opts.correlationId ?? null,
      metadata: opts.metadata ?? null,
      status: RetryOperationStatus.PENDING,
      nextRetryAt: new Date(),
    });

    const saved = await this.retryRepo.save(operation);
    this.logger.log(
      `Scheduled retry operation ${saved.operationId} (type=${saved.operationType})`,
    );
    return saved;
  }

  async markSucceeded(operationId: string): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId },
    });
    if (!operation) return null;

    operation.status = RetryOperationStatus.SUCCEEDED;
    operation.completedAt = new Date();
    operation.nextRetryAt = null;
    const saved = await this.retryRepo.save(operation);

    this.eventEmitter.emit("retry.succeeded", {
      operationId: saved.operationId,
      operationType: saved.operationType,
      attempts: saved.attempts,
    });

    this.logger.log(
      `Operation ${operationId} succeeded after ${saved.attempts} attempt(s)`,
    );
    return saved;
  }

  async markFailed(
    operationId: string,
    error: string,
    retryable = true,
  ): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId },
    });
    if (!operation) return null;

    operation.attempts += 1;
    operation.lastError = error;

    if (!retryable || !operation.retryable) {
      return this.moveToDeadLetter(operation, "Non-retryable failure");
    }

    if (operation.attempts >= operation.maxAttempts) {
      return this.moveToDeadLetter(
        operation,
        `Exhausted ${operation.maxAttempts} retry attempts`,
      );
    }

    operation.status = RetryOperationStatus.PENDING;
    operation.nextRetryAt = this.calculateNextRetry(operation);
    const saved = await this.retryRepo.save(operation);

    this.eventEmitter.emit("retry.failed", {
      operationId: saved.operationId,
      operationType: saved.operationType,
      attempts: saved.attempts,
      maxAttempts: saved.maxAttempts,
      nextRetryAt: saved.nextRetryAt,
      error,
    });

    const nextAt = saved.nextRetryAt instanceof Date
      ? saved.nextRetryAt.toISOString()
      : String(saved.nextRetryAt);
    this.logger.warn(
      `Operation ${operationId} failed (attempt ${saved.attempts}/${saved.maxAttempts}), ` +
        `next retry at ${nextAt}`,
    );
    return saved;
  }

  async getDueOperations(limit = 50): Promise<RetryOperation[]> {
    return this.retryRepo.find({
      where: {
        status: RetryOperationStatus.PENDING,
        nextRetryAt: LessThanOrEqual(new Date()),
      },
      order: { nextRetryAt: "ASC" },
      take: limit,
    });
  }

  async markInProgress(operationId: string): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId },
    });
    if (!operation) return null;

    operation.status = RetryOperationStatus.IN_PROGRESS;
    return this.retryRepo.save(operation);
  }

  async getDeadLetters(
    limit = 50,
    offset = 0,
  ): Promise<{ items: RetryOperation[]; total: number }> {
    const [items, total] = await this.retryRepo.findAndCount({
      where: { status: RetryOperationStatus.DEAD_LETTER },
      order: { deadLetteredAt: "DESC" },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  async retryDeadLetter(
    operationId: string,
    newMaxAttempts?: number,
  ): Promise<RetryOperation | null> {
    const operation = await this.retryRepo.findOne({
      where: { operationId, status: RetryOperationStatus.DEAD_LETTER },
    });
    if (!operation) return null;

    operation.status = RetryOperationStatus.PENDING;
    operation.attempts = 0;
    operation.maxAttempts = newMaxAttempts ?? operation.maxAttempts;
    operation.nextRetryAt = new Date();
    operation.deadLetteredAt = null;
    operation.lastError = null;

    const saved = await this.retryRepo.save(operation);
    this.logger.log(`Dead-lettered operation ${operationId} re-queued for retry`);
    return saved;
  }

  async getOperationStatus(
    operationId: string,
  ): Promise<RetryOperation | null> {
    return this.retryRepo.findOne({ where: { operationId } });
  }

  async getMetrics(): Promise<{
    total: number;
    pending: number;
    inProgress: number;
    succeeded: number;
    failed: number;
    deadLettered: number;
    successRate: number;
    byType: Record<string, number>;
    avgAttemptsBeforeSuccess: number;
  }> {
    const all = await this.retryRepo.find();
    const total = all.length;
    const pending = all.filter(
      (o) => o.status === RetryOperationStatus.PENDING,
    ).length;
    const inProgress = all.filter(
      (o) => o.status === RetryOperationStatus.IN_PROGRESS,
    ).length;
    const succeeded = all.filter(
      (o) => o.status === RetryOperationStatus.SUCCEEDED,
    ).length;
    const failed = all.filter(
      (o) => o.status === RetryOperationStatus.FAILED,
    ).length;
    const deadLettered = all.filter(
      (o) => o.status === RetryOperationStatus.DEAD_LETTER,
    ).length;

    const terminal = succeeded + failed + deadLettered;
    const successRate = terminal > 0 ? (succeeded / terminal) * 100 : 0;

    const byType = all.reduce<Record<string, number>>((acc, o) => {
      acc[o.operationType] = (acc[o.operationType] || 0) + 1;
      return acc;
    }, {});

    const succeededOps = all.filter(
      (o) => o.status === RetryOperationStatus.SUCCEEDED,
    );
    const avgAttemptsBeforeSuccess =
      succeededOps.length > 0
        ? succeededOps.reduce((sum, o) => sum + o.attempts, 0) /
          succeededOps.length
        : 0;

    return {
      total,
      pending,
      inProgress,
      succeeded,
      failed,
      deadLettered,
      successRate,
      byType,
      avgAttemptsBeforeSuccess,
    };
  }

  private async moveToDeadLetter(
    operation: RetryOperation,
    reason: string,
  ): Promise<RetryOperation> {
    operation.status = RetryOperationStatus.DEAD_LETTER;
    operation.deadLetteredAt = new Date();
    operation.nextRetryAt = null;
    const saved = await this.retryRepo.save(operation);

    this.eventEmitter.emit("retry.dead_letter", {
      operationId: saved.operationId,
      operationType: saved.operationType,
      attempts: saved.attempts,
      lastError: saved.lastError,
      reason,
    });

    this.logger.warn(
      `Operation ${saved.operationId} moved to dead letter: ${reason}`,
    );
    return saved;
  }

  private calculateNextRetry(operation: RetryOperation): Date {
    const delay = Math.min(
      operation.backoffMs *
        Math.pow(operation.backoffMultiplier, operation.attempts - 1),
      operation.maxBackoffMs,
    );
    // Add jitter: +/- 10%
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    const totalDelay = Math.max(0, delay + jitter);
    return new Date(Date.now() + totalDelay);
  }
}
