import { BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EMPTY, firstValueFrom, of, throwError } from "rxjs";
import { IdempotencyRecord } from "./entities/idempotency-record.entity";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { IdempotencyService } from "./idempotency.service";

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
    if (index >= 0) this.rows[index] = record;
    else this.rows.push(record);
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

  async remove(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    this.rows = this.rows.filter((row) => row !== record);
    return record;
  }
}

function buildHarness(overrides: {
  method?: string;
  headers?: Record<string, string>;
  user?: { id: string };
  options?: Record<string, unknown>;
  handler?: () => unknown;
}) {
  const repo = new FakeIdempotencyRepository();
  const service = new IdempotencyService(repo as any);
  const reflector = {
    getAllAndOverride: jest.fn(() => overrides.options ?? {}),
  } as unknown as Reflector;
  const interceptor = new IdempotencyInterceptor(service, reflector);

  const request = {
    method: overrides.method ?? "POST",
    url: "/payments",
    route: { path: "/payments" },
    headers: overrides.headers ?? {},
    body: { amount: "10.0000000" },
    params: { id: "payment-1" },
    query: {},
    ip: "127.0.0.1",
    user: overrides.user ?? { id: "user-1" },
  };

  const response = {
    statusCode: 201,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  const context = {
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as any;

  const next = {
    handle: jest.fn(() =>
      overrides.handler ? overrides.handler() : of({ id: "payment-1" })
    ),
  } as any;

  return { interceptor, context, next, response, repo, service };
}

describe("IdempotencyInterceptor", () => {
  it("ignores read-only requests", async () => {
    const { interceptor, context, next, response } = buildHarness({
      method: "GET",
      headers: { "idempotency-key": "order-0001-attempt" },
    });

    const result = await interceptor.intercept(context, next);

    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(await firstValueFrom(result)).toEqual({ id: "payment-1" });
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it("passes unprotected writes through when no key is supplied", async () => {
    const { interceptor, context, next } = buildHarness({});

    const result = await interceptor.intercept(context, next);

    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(await firstValueFrom(result)).toEqual({ id: "payment-1" });
  });

  it("rejects writes that omit a required key", async () => {
    const { interceptor, context, next } = buildHarness({
      options: { required: true },
    });

    await expect(interceptor.intercept(context, next)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(next.handle).not.toHaveBeenCalled();
  });

  it("rejects malformed keys", async () => {
    const { interceptor, context, next } = buildHarness({
      headers: { "idempotency-key": "bad key" },
    });

    await expect(interceptor.intercept(context, next)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(next.handle).not.toHaveBeenCalled();
  });

  it("runs the handler once and stores the response", async () => {
    const { interceptor, context, next, response, repo } = buildHarness({
      headers: { "idempotency-key": "order-0001-attempt" },
    });

    const result = await interceptor.intercept(context, next);
    const body = await firstValueFrom(result);

    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ id: "payment-1" });
    expect(response.setHeader).toHaveBeenCalledWith(
      "idempotency-replayed",
      "false"
    );
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].responseCode).toBe(201);
  });

  it("replays the stored response without invoking the handler again", async () => {
    const headers = { "idempotency-key": "order-0001-attempt" };
    const first = buildHarness({ headers });
    await firstValueFrom(await first.interceptor.intercept(first.context, first.next));

    // Same key, same payload, same actor, but a fresh request/response pair.
    const second = buildHarness({ headers });
    second.repo.rows = first.repo.rows;

    const result = await second.interceptor.intercept(second.context, second.next);

    expect(result).toBe(EMPTY);
    expect(second.next.handle).not.toHaveBeenCalled();
    expect(second.response.status).toHaveBeenCalledWith(201);
    expect(second.response.json).toHaveBeenCalledWith({ id: "payment-1" });
    expect(second.response.setHeader).toHaveBeenCalledWith(
      "idempotency-replayed",
      "true"
    );
  });

  it("scopes keys per actor so two users cannot replay each other", async () => {
    const headers = { "idempotency-key": "order-0001-attempt" };
    const first = buildHarness({ headers, user: { id: "user-1" } });
    await firstValueFrom(await first.interceptor.intercept(first.context, first.next));

    const second = buildHarness({ headers, user: { id: "user-2" } });
    second.repo.rows = first.repo.rows;

    await second.interceptor.intercept(second.context, second.next);

    expect(second.next.handle).toHaveBeenCalledTimes(1);
    expect(second.repo.rows).toHaveLength(2);
  });

  it("does not cache failed writes", async () => {
    const { interceptor, context, next, repo } = buildHarness({
      headers: { "idempotency-key": "order-0001-attempt" },
      handler: () => throwError(() => new Error("upstream timeout")),
    });

    await expect(interceptor.intercept(context, next)).rejects.toThrow(
      "upstream timeout"
    );
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].status).toBe("failed");
    expect(repo.rows[0].responseBody).toBeNull();
  });
});
