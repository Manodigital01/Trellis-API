import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { LessThan, Repository } from "typeorm";
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENT_METHODS,
  MAX_IDEMPOTENCY_TTL_SECONDS,
} from "./idempotency.constants";
import {
  IdempotencyRecord,
  IdempotencyRecordStatus,
} from "./entities/idempotency-record.entity";

export interface IdempotentOutcome<T = unknown> {
  /** True when the stored response was returned instead of running the handler. */
  replayed: boolean;
  statusCode: number;
  body: T;
  key: string;
}

export interface ExecuteIdempotentParams<T> {
  key: string;
  scope: string;
  requestHash: string;
  ttlSeconds?: number;
  /** Runs exactly once per `(scope, key, requestHash)` triple. */
  handler: () => Promise<{ statusCode: number; body: T }>;
}

/**
 * Server-side replay protection for high-risk write operations.
 *
 * Guarantees for a given `(scope, idempotencyKey)`:
 *  - the handler runs at most once while a record is fresh;
 *  - concurrent duplicates are rejected with 409 instead of double-executing;
 *  - reusing a key with a *different* payload is rejected with 409;
 *  - successes are replayed from storage for `ttlSeconds`;
 *  - failures are not cached, so a client retry can make progress.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyRecord)
    private readonly repo: Repository<IdempotencyRecord>
  ) {}

  isIdempotentMethod(method: string): boolean {
    return (IDEMPOTENT_METHODS as readonly string[]).includes(
      String(method).toUpperCase()
    );
  }

  /**
   * Keys are scoped by method + route + actor so the same client-generated
   * value on two different endpoints (or two different users) cannot collide.
   */
  buildScope(method: string, route: string, actor?: string | null): string {
    const normalizedRoute =
      String(route ?? "")
        .split("?")[0]
        .replace(/\/+$/, "") || "/";
    const normalizedActor = actor ? String(actor) : "anonymous";
    return `${String(method).toUpperCase()}:${normalizedRoute}:${normalizedActor}`.slice(
      0,
      255
    );
  }

  /** Stable, order-independent SHA-256 of the request payload. */
  hashRequest(payload: unknown): string {
    return createHash("sha256").update(this.canonicalize(payload)).digest("hex");
  }

  /** Validates and normalizes a client-supplied key. */
  assertValidKey(key: string): string {
    const value = typeof key === "string" ? key.trim() : "";
    if (!value) {
      throw new BadRequestException(
        "Missing Idempotency-Key header for a mutating request"
      );
    }
    if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be at least ${IDEMPOTENCY_KEY_MIN_LENGTH} characters`
      );
    }
    if (value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException(
        "Idempotency-Key may only contain letters, digits, and . _ : + -"
      );
    }
    return value;
  }

  async execute<T>(
    params: ExecuteIdempotentParams<T>
  ): Promise<IdempotentOutcome<T>> {
    const key = this.assertValidKey(params.key);
    const { scope, requestHash } = params;

    const existing = await this.repo.findOne({
      where: { scope, idempotencyKey: key },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          "Idempotency-Key was already used for a different request payload"
        );
      }

      if (this.isExpired(existing)) {
        await this.repo.remove(existing);
      } else if (existing.status === IdempotencyRecordStatus.COMPLETED) {
        return {
          replayed: true,
          statusCode: existing.responseCode ?? 200,
          body: this.readStoredBody<T>(existing),
          key,
        };
      } else if (existing.status === IdempotencyRecordStatus.IN_PROGRESS) {
        throw new ConflictException(
          "A request with this Idempotency-Key is already in progress"
        );
      } else {
        // A previous attempt failed: drop the marker so the retry can run.
        await this.repo.remove(existing);
      }
    }

    const record = this.repo.create({
      scope,
      idempotencyKey: key,
      requestHash,
      status: IdempotencyRecordStatus.IN_PROGRESS,
      responseCode: null,
      responseBody: null,
      failureReason: null,
      expiresAt: this.expiry(params.ttlSeconds),
    });
    await this.repo.save(record);

    try {
      const { statusCode, body } = await params.handler();
      record.status = IdempotencyRecordStatus.COMPLETED;
      record.responseCode = statusCode;
      record.responseBody = { payload: body ?? null };
      await this.repo.save(record);
      return { replayed: false, statusCode, body, key };
    } catch (error) {
      record.status = IdempotencyRecordStatus.FAILED;
      record.responseCode = null;
      record.failureReason =
        error instanceof Error ? error.message : String(error);
      await this.repo.save(record);
      this.logger.warn(
        `Idempotent request failed (scope=${scope}) and may be retried`
      );
      throw error;
    }
  }

  /** Deletes records past their TTL. Safe to call from a scheduled job. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.repo.find({
      where: { expiresAt: LessThan(now) },
    });
    if (expired.length === 0) return 0;
    await this.repo.remove(expired);
    this.logger.log(`Purged ${expired.length} expired idempotency records`);
    return expired.length;
  }

  private isExpired(record: IdempotencyRecord): boolean {
    if (!(record.expiresAt instanceof Date)) return true;
    return record.expiresAt.getTime() <= Date.now();
  }

  private readStoredBody<T>(record: IdempotencyRecord): T {
    const stored = record.responseBody;
    if (stored && Object.prototype.hasOwnProperty.call(stored, "payload")) {
      return stored.payload as T;
    }
    return undefined as unknown as T;
  }

  private expiry(ttlSeconds?: number): Date {
    return new Date(Date.now() + this.resolveTtl(ttlSeconds) * 1000);
  }

  private resolveTtl(ttlSeconds?: number): number {
    if (typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)) {
      return Math.min(Math.max(Math.floor(ttlSeconds), 1), MAX_IDEMPOTENCY_TTL_SECONDS);
    }
    const fromEnv = Number(process.env.IDEMPOTENCY_TTL_SECONDS);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
      return Math.min(fromEnv, MAX_IDEMPOTENCY_TTL_SECONDS);
    }
    return DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  }

  /**
   * Deterministic JSON: object keys are sorted and non-JSON values are
   * normalized, so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
   */
  private canonicalize(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalize(item)).join(",")}]`;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map(
          (keyName) =>
            `${JSON.stringify(keyName)}:${this.canonicalize(record[keyName])}`
        );
      return `{${entries.join(",")}}`;
    }
    return "null";
  }
}
