import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import * as speakeasy from "speakeasy";
import { AdminTwoFactorGuard, RedisLikeClient } from "./admin-two-factor.guard";

describe("AdminTwoFactorGuard", () => {
  let guard: AdminTwoFactorGuard;
  let isTwoFactorEnabled: jest.Mock;
  let validateTotpToken: jest.Mock;
  let userRepository: { findOne: jest.Mock };
  let twoFactorRepository: { findOne: jest.Mock };
  let mockRedis: RedisLikeClient;
  let redisStore: Map<string, string>;

  const secret = speakeasy.generateSecret();

  const contextWith = (
    user: unknown,
    headers: Record<string, string> = {},
    body: Record<string, any> = {},
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user, headers, body }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    isTwoFactorEnabled = jest.fn();
    validateTotpToken = jest
      .fn()
      .mockImplementation((_userId, token, window = 1) =>
        speakeasy.totp.verify({
          secret: secret.base32,
          encoding: "base32",
          token,
          window,
        }),
      );
    userRepository = { findOne: jest.fn() };
    twoFactorRepository = {
      findOne: jest.fn().mockResolvedValue({
        userId: "admin-1",
        secret: secret.base32,
        isEnabled: true,
        status: "verified",
      }),
    };
    redisStore = new Map();
    mockRedis = {
      set: jest.fn(async (key, val, _mode, _ttl) => {
        redisStore.set(key, val);
        return "OK";
      }),
      exists: jest.fn(async (key) => (redisStore.has(key) ? 1 : 0)),
      del: jest.fn(async (key) => (redisStore.delete(key) ? 1 : 0)),
    };

    guard = new AdminTwoFactorGuard(
      { isTwoFactorEnabled, validateTotpToken } as never,
      userRepository as never,
      twoFactorRepository as never,
      mockRedis,
    );
  });

  afterEach(async () => {
    await guard.onModuleDestroy();
  });

  it("allows non-admin users through without checking 2FA", async () => {
    await expect(
      guard.canActivate(contextWith({ id: "u1", role: "user" })),
    ).resolves.toBe(true);
    expect(isTwoFactorEnabled).not.toHaveBeenCalled();
  });

  it("blocks an admin who has not enabled 2FA", async () => {
    isTwoFactorEnabled.mockResolvedValue(false);
    await expect(
      guard.canActivate(
        contextWith({ id: "admin-1", role: "admin", twoFactorVerified: true }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks an admin with 2FA enabled but an unverified session and no TOTP header", async () => {
    isTwoFactorEnabled.mockResolvedValue(true);
    await expect(
      guard.canActivate(
        contextWith({ id: "admin-1", role: "admin", twoFactorVerified: false }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows an admin with 2FA enabled and a verified session", async () => {
    isTwoFactorEnabled.mockResolvedValue(true);
    await expect(
      guard.canActivate(
        contextWith({ id: "admin-1", role: "admin", twoFactorVerified: true }),
      ),
    ).resolves.toBe(true);
  });

  it("resolves a wallet admin's user id from the wallet address", async () => {
    userRepository.findOne.mockResolvedValue({ id: "admin-2" });
    isTwoFactorEnabled.mockResolvedValue(true);

    await expect(
      guard.canActivate(
        contextWith({
          address: "0xABC",
          role: "admin",
          twoFactorVerified: true,
        }),
      ),
    ).resolves.toBe(true);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { walletAddress: "0xabc" },
    });
    expect(isTwoFactorEnabled).toHaveBeenCalledWith("admin-2");
  });

  describe("TOTP token replay protection & clock skew tolerance", () => {
    it("allows admin with a fresh valid TOTP token in request header", async () => {
      isTwoFactorEnabled.mockResolvedValue(true);
      const token = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
      });

      const ctx = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-code": token },
      );

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(await guard.isTokenUsed("admin-1", token)).toBe(true);
    });

    it("rejects replaying the same TOTP token twice with 401 Unauthorized", async () => {
      isTwoFactorEnabled.mockResolvedValue(true);
      const token = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
      });

      const ctx1 = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-code": token },
      );

      // First attempt succeeds
      await expect(guard.canActivate(ctx1)).resolves.toBe(true);

      const ctx2 = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-code": token },
      );

      // Second attempt with same token within TTL must be rejected with 401 Unauthorized
      await expect(guard.canActivate(ctx2)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(guard.canActivate(ctx2)).rejects.toThrow(
        "TOTP token has already been used",
      );
    });

    it("accepts TOTP token with +/- 1 step clock skew tolerance", async () => {
      isTwoFactorEnabled.mockResolvedValue(true);
      // Generate token for previous step (-30s)
      const pastToken = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
        time: Math.floor(Date.now() / 1000) - 30,
      });

      const ctx = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-token": pastToken },
      );

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("rejects invalid TOTP token with 401 Unauthorized", async () => {
      isTwoFactorEnabled.mockResolvedValue(true);
      const ctx = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-code": "000000" },
      );

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        "Invalid two-factor authentication code",
      );
    });

    it("falls back to in-memory cache when Redis is unavailable", async () => {
      const memoryGuard = new AdminTwoFactorGuard(
        { isTwoFactorEnabled, validateTotpToken } as never,
        userRepository as never,
        twoFactorRepository as never,
        null,
      );

      isTwoFactorEnabled.mockResolvedValue(true);
      const token = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
      });

      const ctx1 = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-code": token },
      );

      await expect(memoryGuard.canActivate(ctx1)).resolves.toBe(true);

      const ctx2 = contextWith(
        { id: "admin-1", role: "admin", twoFactorVerified: false },
        { "x-totp-code": token },
      );

      await expect(memoryGuard.canActivate(ctx2)).rejects.toThrow(
        UnauthorizedException,
      );

      await memoryGuard.onModuleDestroy();
    });
  });
});
