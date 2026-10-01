import { Test, TestingModule } from "@nestjs/testing";
import {
  RedisLikeClient,
  TokenBlacklistService,
} from "./token-blacklist.service";

/**
 * The service is async because a Redis-backed revocation check is a network
 * call. These tests cover both modes: the in-process fallback (no client) and
 * the distributed path (a stub client), including the fail-closed behaviour
 * when Redis is unreachable.
 */
describe("TokenBlacklistService", () => {
  describe("in-process fallback (no Redis)", () => {
    let service: TokenBlacklistService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [TokenBlacklistService],
      }).compile();
      service = module.get<TokenBlacklistService>(TokenBlacklistService);
      jest.clearAllMocks();
      await service.onModuleDestroy();
    });

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it("should be defined", () => {
      expect(service).toBeDefined();
    });

    it("reports that it is not distributed", () => {
      expect(service.isDistributed()).toBe(false);
    });

    describe("revoke", () => {
      it("should revoke a token by jti", async () => {
        const futureMs = Date.now() + 3600000;
        await service.revoke("jti-1", futureMs);
        expect(await service.isRevoked("jti-1")).toBe(true);
      });
    });

    describe("isRevoked", () => {
      it("should return false for an unknown jti", async () => {
        expect(await service.isRevoked("unknown-jti")).toBe(false);
      });

      it("should return true for a revoked jti", async () => {
        await service.revoke("jti-2", Date.now() + 3600000);
        expect(await service.isRevoked("jti-2")).toBe(true);
      });

      it("should return false for an expired revoke entry", async () => {
        await service.revoke("jti-expired", Date.now() - 1000);
        expect(await service.isRevoked("jti-expired")).toBe(false);
      });
    });
  });

  describe("Redis-backed", () => {
    function makeClient(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
      const store = new Map<string, number>();
      return {
        set: jest.fn(async (key: string, _value: string, _mode: "EX", ttl: number) => {
          store.set(key, Date.now() + ttl * 1000);
          return "OK";
        }),
        exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
        ...overrides,
      } as RedisLikeClient;
    }

    it("uses Redis for the revocation set when a client is provided", async () => {
      const client = makeClient();
      const service = new TokenBlacklistService(client);

      expect(service.isDistributed()).toBe(true);

      await service.revoke("jti-redis", Date.now() + 3600000);
      expect(client.set).toHaveBeenCalledWith(
        "token-blacklist:jti-redis",
        "1",
        "EX",
        expect.any(Number),
      );
      expect(await service.isRevoked("jti-redis")).toBe(true);
      expect(client.exists).toHaveBeenCalledWith("token-blacklist:jti-redis");

      await service.onModuleDestroy();
    });

    it("passes a TTL that matches the remaining token lifetime", async () => {
      const client = makeClient();
      const service = new TokenBlacklistService(client);

      await service.revoke("jti-ttl", Date.now() + 120_000);

      const call = (client.set as jest.Mock).mock.calls[0];
      const ttl = call[3] as number;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);

      await service.onModuleDestroy();
    });

    it("never writes a zero or negative TTL", async () => {
      const client = makeClient();
      const service = new TokenBlacklistService(client);

      // A token that has already expired: Redis rejects a non-positive EX.
      await service.revoke("jti-past", Date.now() - 5000);

      const ttl = (client.set as jest.Mock).mock.calls[0][3] as number;
      expect(ttl).toBeGreaterThanOrEqual(1);

      await service.onModuleDestroy();
    });

    // Fail-closed: a Redis outage must not make a revoked token look valid.
    it("falls back to local state when Redis throws on revoke", async () => {
      const client = makeClient({
        set: jest.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const service = new TokenBlacklistService(client);

      await service.revoke("jti-outage", Date.now() + 3600000);

      // The local map recorded it, so the token is still treated as revoked
      // in this process even though Redis did not get the write.
      client.set = jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      expect(await service.isRevoked("jti-outage")).toBe(true);

      await service.onModuleDestroy();
    });

    it("falls back to local state when Redis throws on lookup", async () => {
      const client = makeClient({
        exists: jest.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const service = new TokenBlacklistService(client);

      // No local entry, Redis unreachable: the safe answer is "not known to
      // be revoked locally", which the caller treats as a lookup failure.
      expect(await service.isRevoked("jti-unknown")).toBe(false);

      await service.onModuleDestroy();
    });
  });
});
