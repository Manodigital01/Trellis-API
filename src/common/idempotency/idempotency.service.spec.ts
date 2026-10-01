import { BadRequestException, ConflictException } from "@nestjs/common";
import { FindOperator } from "typeorm";
import {
  IdempotencyRecord,
  IdempotencyRecordStatus,
} from "./entities/idempotency-record.entity";
import { IdempotencyService } from "./idempotency.service";

/**
 * Minimal in-memory stand-in for `Repository<IdempotencyRecord>`. Only the
 * methods the service actually calls are implemented, which keeps the suite
 * free of a database while still exercising the real lookup/insert/remove
 * ordering.
 */
class FakeIdempotencyRepository {
  rows: IdempotencyRecord[] = [];

  create(partial: Partial<IdempotencyRecord>): IdempotencyRecord {
    return { ...partial } as IdempotencyRecord;
  }

  async save(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const index = this.rows.findIndex(
      (row) =>
        row.scope === record.scope &&
        row.idempotencyKey === record.idempotencyKey
    );
    if (index >= 0) {
      this.rows[index] = record;
    } else {
      this.rows.push(record);
    }
    return record;
  }

  async findOne(options: {
    where: { scope: string; idempotencyKey: string };
  }): Promise<IdempotencyRecord | null> {
    const { scope, idempotencyKey } = options.where;
    return (
      this.rows.find(
        (row) => row.scope === scope && row.idempotencyKey === idempotencyKey
      ) ?? null
    );
  }

  async find(options?: {
    where?: { expiresAt?: unknown };
  }): Promise<IdempotencyRecord[]> {
    const criteria = options?.where?.expiresAt as FindOperator<Date> | undefined;
    // The service filters with TypeORM's `LessThan`, so resolve that intent
    // directly instead of re-implementing SQL comparison operators.
    if (criteria && criteria.type === "lessThan") {
      const now = criteria.value as Date;
      return this.rows.filter(
        (row) => row.expiresAt.getTime() < now.getTime()
      );
    }
    return [...this.rows];
  }

  async remove(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    this.rows = this.rows.filter((row) => row !== record);
    return record;
  }
}

const SCOPE = "POST:/payments:user-1";

function buildService(): {
  service: IdempotencyService;
  repo: FakeIdempotencyRepository;
} {
  const repo = new FakeIdempotencyRepository();
  const service = new IdempotencyService(repo as any);
  return { service, repo };
}

describe("IdempotencyService", () => {
  let service: IdempotencyService;
  let repo: FakeIdempotencyRepository;

  beforeEach(() => {
    ({ service, repo } = buildService());
  });

  it("executes the handler once and replays the stored response", async () => {
    const handler = jest.fn(async () => ({
      statusCode: 201,
      body: { id: "payment-1" },
    }));

    const first = await service.execute({
      key: "order-0001-attempt",
      scope: SCOPE,
      requestHash: service.hashRequest({ amount: "10.0000000" }),
      handler,
    });

    const second = await service.execute({
      key: "order-0001-attempt",
      scope: SCOPE,
      requestHash: service.hashRequest({ amount: "10.0000000" }),
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.statusCode).toBe(201);
    expect(second.body).toEqual({ id: "payment-1" });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].status).toBe(IdempotencyRecordStatus.COMPLETED);
  });

  it("rejects reuse of a key with a different payload", async () => {
    const handler = jest.fn(async () => ({ statusCode: 200, body: "ok" }));

    await service.execute({
      key: "order-0002-attempt",
      scope: SCOPE,
      requestHash: service.hashRequest({ amount: "10.0000000" }),
      handler,
    });

    await expect(
      service.execute({
        key: "order-0002-attempt",
        scope: SCOPE,
        requestHash: service.hashRequest({ amount: "999.0000000" }),
        handler,
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent retry while the original request is in progress", async () => {
    await repo.save(
      repo.create({
        scope: SCOPE,
        idempotencyKey: "order-0003-attempt",
        requestHash: service.hashRequest({ amount: "5.0000000" }),
        status: IdempotencyRecordStatus.IN_PROGRESS,
        responseCode: null,
        responseBody: null,
        failureReason: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
    );

    const handler = jest.fn(async () => ({ statusCode: 200, body: "ok" }));

    await expect(
      service.execute({
        key: "order-0003-attempt",
        scope: SCOPE,
        requestHash: service.hashRequest({ amount: "5.0000000" }),
        handler,
      })
    ).rejects.toBeInstanceOf(ConflictException);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not cache failures so the client can retry", async () => {
    const payload = { amount: "7.0000000" };
    const requestHash = service.hashRequest(payload);
    const failing = jest.fn(async () => {
      throw new Error("ledger unavailable");
    });

    await expect(
      service.execute({
        key: "order-0004-attempt",
        scope: SCOPE,
        requestHash,
        handler: failing,
      })
    ).rejects.toThrow("ledger unavailable");

    expect(repo.rows[0].status).toBe(IdempotencyRecordStatus.FAILED);
    expect(repo.rows[0].failureReason).toBe("ledger unavailable");

    const succeeding = jest.fn(async () => ({
      statusCode: 201,
      body: { id: "payment-4" },
    }));

    const retry = await service.execute({
      key: "order-0004-attempt",
      scope: SCOPE,
      requestHash,
      handler: succeeding,
    });

    expect(retry.replayed).toBe(false);
    expect(retry.body).toEqual({ id: "payment-4" });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].status).toBe(IdempotencyRecordStatus.COMPLETED);
  });

  it("re-executes once a stored response has expired", async () => {
    await repo.save(
      repo.create({
        scope: SCOPE,
        idempotencyKey: "order-0005-attempt",
        requestHash: service.hashRequest({ amount: "1.0000000" }),
        status: IdempotencyRecordStatus.COMPLETED,
        responseCode: 201,
        responseBody: { payload: { id: "stale" } },
        failureReason: null,
        expiresAt: new Date(Date.now() - 1_000),
      })
    );

    const handler = jest.fn(async () => ({
      statusCode: 201,
      body: { id: "fresh" },
    }));

    const outcome = await service.execute({
      key: "order-0005-attempt",
      scope: SCOPE,
      requestHash: service.hashRequest({ amount: "1.0000000" }),
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcome.replayed).toBe(false);
    expect(outcome.body).toEqual({ id: "fresh" });
    expect(repo.rows).toHaveLength(1);
  });

  it("keeps the same key on different routes or actors isolated", async () => {
    const hash = service.hashRequest({ amount: "3.0000000" });
    const handler = jest.fn(async () => ({ statusCode: 200, body: "ok" }));

    await service.execute({ key: "shared-key-value", scope: SCOPE, requestHash: hash, handler });
    await service.execute({
      key: "shared-key-value",
      scope: "POST:/withdrawals:user-1",
      requestHash: hash,
      handler,
    });
    await service.execute({
      key: "shared-key-value",
      scope: "POST:/payments:user-2",
      requestHash: hash,
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(repo.rows).toHaveLength(3);
  });

  it("hashes payloads independently of key order", () => {
    expect(service.hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      service.hashRequest({ b: { d: 3, c: 2 }, a: 1 })
    );
    expect(service.hashRequest({ a: 1 })).not.toBe(service.hashRequest({ a: 2 }));
  });

  it("rejects malformed idempotency keys", () => {
    expect(() => service.assertValidKey("short")).toThrow(BadRequestException);
    expect(() => service.assertValidKey("has spaces here")).toThrow(
      BadRequestException
    );
    expect(() => service.assertValidKey("")).toThrow(BadRequestException);
    expect(service.assertValidKey("  order-0001-attempt  ")).toBe(
      "order-0001-attempt"
    );
  });

  it("only purges expired records", async () => {
    await repo.save(
      repo.create({
        scope: SCOPE,
        idempotencyKey: "expired-key-01",
        requestHash: "hash",
        status: IdempotencyRecordStatus.COMPLETED,
        responseCode: 200,
        responseBody: { payload: null },
        failureReason: null,
        expiresAt: new Date(Date.now() - 10_000),
      })
    );
    await repo.save(
      repo.create({
        scope: SCOPE,
        idempotencyKey: "live-key-0001",
        requestHash: "hash",
        status: IdempotencyRecordStatus.COMPLETED,
        responseCode: 200,
        responseBody: { payload: null },
        failureReason: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
    );

    await expect(service.purgeExpired()).resolves.toBe(1);
    expect(repo.rows.map((row) => row.idempotencyKey)).toEqual(["live-key-0001"]);
  });

  it("classifies mutating methods only", () => {
    expect(service.isIdempotentMethod("post")).toBe(true);
    expect(service.isIdempotentMethod("PATCH")).toBe(true);
    expect(service.isIdempotentMethod("delete")).toBe(true);
    expect(service.isIdempotentMethod("GET")).toBe(false);
    expect(service.isIdempotentMethod("HEAD")).toBe(false);
  });
});
