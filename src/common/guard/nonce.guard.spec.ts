import { Test, TestingModule } from "@nestjs/testing";
import {
  ExecutionContext,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type Redis from "ioredis";
import { CACHE_REDIS_CLIENT } from "../cache/cache.constants";
import {
  CONSUME_NONCE_LUA,
  DEFAULT_NONCE_TTL_SECONDS,
  NONCE_KEY_PREFIX,
  NonceGuard,
} from "./nonce.guard";

/**
 * Stand-in for the shared Redis instance that every node of one deployment
 * sees. `eval` applies the semantics of CONSUME_NONCE_LUA — atomic
 * compare-and-set plus TTL — to a Map shared by all callers.
 */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly scripts: string[] = [];
  failWith: Error | null = null;

  async eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<[number, string]> {
    this.scripts.push(script);

    if (this.failWith) throw this.failWith;

    const key = String(args[0]);
    const incoming = String(args[1]);
    const ttl = Number(args[2]);

    if (numKeys !== 1) throw new Error("expected exactly one key");

    const current = this.store.get(key);
    if (current !== undefined) {
      const isReplay =
        incoming.length < current.length
          ? false
          : incoming.length > current.length
            ? true
            : incoming <= current;
      if (isReplay) return [0, current];
    }

    this.store.set(key, incoming);
    this.ttls.set(key, ttl);
    return [1, "0"];
  }
}

function makeContext(body: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body }),
    }),
  } as unknown as ExecutionContext;
}

async function wireGuard(redis: FakeRedis | null): Promise<NonceGuard> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [NonceGuard, { provide: CACHE_REDIS_CLIENT, useValue: redis }],
  }).compile();

  return module.get<NonceGuard>(NonceGuard);
}

describe("NonceGuard", () => {
  describe("in-process fallback (no Redis client)", () => {
    let guard: NonceGuard;

    beforeEach(async () => {
      guard = await wireGuard(null);
    });

    it("rejects request missing nonce", async () => {
      await expect(
        guard.canActivate(makeContext({ userId: "u1" })),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects request missing userId", async () => {
      await expect(guard.canActivate(makeContext({ nonce: 1 }))).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects a non-integer nonce instead of throwing a syntax error", async () => {
      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: "1;DROP" })),
      ).rejects.toThrow(BadRequestException);
    });

    it("reports that tracking is not distributed", () => {
      expect(guard.isDistributed()).toBe(false);
    });

    it("accepts first-time nonce", async () => {
      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 1 })),
      ).resolves.toBe(true);
    });

    it("accepts higher nonce", async () => {
      await guard.canActivate(makeContext({ userId: "u1", nonce: 5 }));

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 6 })),
      ).resolves.toBe(true);
    });

    it("rejects duplicate nonce with HTTP 409", async () => {
      await guard.canActivate(makeContext({ userId: "u1", nonce: 5 }));

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 5 })),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects replay attack (lower nonce)", async () => {
      await guard.canActivate(makeContext({ userId: "u1", nonce: 10 }));

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 3 })),
      ).rejects.toThrow(ConflictException);
    });

    it("keeps nonces independent per subject", async () => {
      await guard.canActivate(makeContext({ userId: "u1", nonce: 10 }));

      await expect(
        guard.canActivate(makeContext({ userId: "u2", nonce: 1 })),
      ).resolves.toBe(true);
    });

    it("handles 64-bit nonces without precision loss", async () => {
      const big = "18446744073709551615";
      await guard.canActivate(makeContext({ userId: "u1", nonce: big }));

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: big })),
      ).rejects.toThrow(ConflictException);
    });

    it("stops rejecting a nonce once its TTL has elapsed", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const shortLived = new NonceGuard(null, 1);

        await shortLived.canActivate(makeContext({ userId: "u1", nonce: 1 }));
        await expect(
          shortLived.canActivate(makeContext({ userId: "u1", nonce: 1 })),
        ).rejects.toThrow(ConflictException);

        jest.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
        await expect(
          shortLived.canActivate(makeContext({ userId: "u1", nonce: 1 })),
        ).resolves.toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("Redis-backed", () => {
    let redis: FakeRedis;

    beforeEach(() => {
      redis = new FakeRedis();
    });

    it("records the nonce through the atomic Lua script", async () => {
      const guard = await wireGuard(redis);
      expect(guard.isDistributed()).toBe(true);

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 7 })),
      ).resolves.toBe(true);

      expect(redis.scripts).toEqual([CONSUME_NONCE_LUA]);
      expect(redis.store.get(`${NONCE_KEY_PREFIX}u1`)).toBe("7");
      expect(redis.ttls.get(`${NONCE_KEY_PREFIX}u1`)).toBe(
        DEFAULT_NONCE_TTL_SECONDS,
      );
    });

    it("writes with GETSET and expires the entry with EXPIRE", () => {
      expect(CONSUME_NONCE_LUA).toContain("redis.call('GETSET'");
      expect(CONSUME_NONCE_LUA).toContain("redis.call('EXPIRE'");
    });

    it("honours a TTL override", async () => {
      const guard = new NonceGuard(redis as unknown as Redis, 42);

      await guard.canActivate(makeContext({ userId: "u1", nonce: 1 }));

      expect(redis.ttls.get(`${NONCE_KEY_PREFIX}u1`)).toBe(42);
    });

    it("rejects a nonce the script reports as a replay", async () => {
      const guard = await wireGuard(redis);
      await guard.canActivate(makeContext({ userId: "u1", nonce: 5 }));

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 5 })),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects the same nonce submitted to two separate API nodes", async () => {
      // Two guards, one Redis: the second node must see the first node's write.
      const nodeA = await wireGuard(redis);
      const nodeB = await wireGuard(redis);

      await expect(
        nodeA.canActivate(makeContext({ userId: "u1", nonce: 42 })),
      ).resolves.toBe(true);

      await expect(
        nodeB.canActivate(makeContext({ userId: "u1", nonce: 42 })),
      ).rejects.toThrow(ConflictException);
    });

    it("admits exactly one winner when both nodes submit the same nonce at once", async () => {
      const nodeA = await wireGuard(redis);
      const nodeB = await wireGuard(redis);

      const results = await Promise.allSettled([
        nodeA.canActivate(makeContext({ userId: "u1", nonce: 9 })),
        nodeB.canActivate(makeContext({ userId: "u1", nonce: 9 })),
      ]);

      const accepted = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
    });

    it("fails closed instead of falling back to per-process state", async () => {
      const guard = await wireGuard(redis);
      redis.failWith = new Error("READONLY replica");

      await expect(
        guard.canActivate(makeContext({ userId: "u1", nonce: 1 })),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
