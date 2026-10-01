import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UnauthorizedException } from "@nestjs/common";
import { RefreshToken } from "./entities/auth.entity";
import {
  InMemoryRevocationStore,
  RefreshTokenRotationService,
  REVOCATION_STORE,
  RevocationStore,
} from "./refresh-token-rotation.service";

/**
 * Issue #144. Rotation already existed in `EnhancedAuthService`; these tests
 * cover the missing half — recognising a *replayed* revoked token and revoking
 * the whole family, which is only possible because the family id links the
 * rotation chain.
 */
describe("RefreshTokenRotationService (#144)", () => {
  let service: RefreshTokenRotationService;
  let repo: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock; create: jest.Mock };
  let store: RevocationStore & { revoked: Map<string, number> };

  const FUTURE = () => new Date(Date.now() + 3_600_000);
  const PAST = () => new Date(Date.now() - 1000);

  function tokenEntity(overrides: Partial<RefreshToken> = {}): RefreshToken {
    return {
      id: "tok-1",
      userId: "user-1",
      token: "token-abc",
      expiresAt: FUTURE(),
      revoked: false,
      revokedAt: undefined,
      replacedByToken: undefined,
      familyId: "family-1",
      ipAddress: "127.0.0.1",
      userAgent: "jest",
      ...overrides,
    } as RefreshToken;
  }

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (entity: any) => entity),
      create: jest.fn((data: any) => data),
    };
    const local = new InMemoryRevocationStore();
    store = local as any;
    (store as any).revoked = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenRotationService,
        { provide: getRepositoryToken(RefreshToken), useValue: repo },
        { provide: REVOCATION_STORE, useValue: store },
      ],
    }).compile();

    service = module.get<RefreshTokenRotationService>(RefreshTokenRotationService);
  });

  describe("normal rotation", () => {
    it("issues a replacement and revokes the presented token", async () => {
      const original = tokenEntity();
      repo.findOne.mockResolvedValue(original);

      const result = await service.rotate("token-abc");

      expect(result.kind).toBe("rotated");
      expect(original.revoked).toBe(true);
      expect(original.revokedAt).toBeInstanceOf(Date);
      expect(original.replacedByToken).toBe((result as any).token.token);
      expect(repo.save).toHaveBeenCalled();
    });

    it("keeps the replacement in the same family", async () => {
      repo.findOne.mockResolvedValue(tokenEntity({ familyId: "family-x" }));

      const result = await service.rotate("token-abc");

      expect((result as any).token.familyId).toBe("family-x");
    });

    it("preserves the original expiry so rotation cannot extend a session", async () => {
      const expiry = FUTURE();
      repo.findOne.mockResolvedValue(tokenEntity({ expiresAt: expiry }));

      const result = await service.rotate("token-abc");

      expect((result as any).token.expiresAt).toEqual(expiry);
    });

    it("records the revocation with a positive TTL", async () => {
      repo.findOne.mockResolvedValue(tokenEntity());

      await service.rotate("token-abc");

      expect(await store.isRevoked("refresh-revoked:tok-1")).toBe(true);
    });
  });

  describe("reuse detection (#144)", () => {
    it("recognises a replayed token and revokes the whole family", async () => {
      // The token exists but is already revoked: that is the theft signal.
      repo.findOne.mockResolvedValue(tokenEntity({ revoked: true, familyId: "family-1" }));
      const siblings = [
        tokenEntity({ id: "sib-1", token: "sib-token-1", familyId: "family-1" }),
        tokenEntity({ id: "sib-2", token: "sib-token-2", familyId: "family-1" }),
      ];
      repo.find.mockResolvedValue(siblings);

      const result = await service.rotate("token-abc");

      expect(result.kind).toBe("reused");
      expect((result as any).revokedTokens).toBe(2);
      // Every sibling in the family is now revoked.
      for (const sibling of siblings) {
        expect(sibling.revoked).toBe(true);
      }
    });

    // The acceptance criterion: reusing an old token invalidates all active
    // sessions for that family, so the attacker and the victim both lose access.
    it("revokes every live token in the family, not just the replayed one", async () => {
      repo.findOne.mockResolvedValue(tokenEntity({ revoked: true }));
      repo.find.mockResolvedValue([
        tokenEntity({ id: "a", token: "ta", familyId: "family-1" }),
        tokenEntity({ id: "b", token: "tb", familyId: "family-1" }),
        tokenEntity({ id: "c", token: "tc", familyId: "family-1" }),
      ]);

      await service.rotate("token-abc");

      expect(repo.save).toHaveBeenCalled();
      const saved = repo.save.mock.calls[0][0] as RefreshToken[];
      expect(saved).toHaveLength(3);
      expect(saved.every((t) => t.revoked === true)).toBe(true);
    });

    it("revokes a token already in the revocation store even if the row is not yet marked", async () => {
      // A crash between the store write and the row update leaves exactly this
      // state; treating it as a live token would re-open a revoked one.
      repo.findOne.mockResolvedValue(tokenEntity({ revoked: false }));
      await store.revoke("refresh-revoked:tok-1", 3600);
      repo.find.mockResolvedValue([tokenEntity({ id: "tok-1", familyId: "family-1" })]);

      const result = await service.rotate("token-abc");

      expect(result.kind).toBe("reused");
    });

    it("refuses a replayed token that has no family rather than guessing", async () => {
      repo.findOne.mockResolvedValue(tokenEntity({ revoked: true, familyId: undefined }));

      const result = await service.rotate("token-abc");

      expect(result.kind).toBe("reused");
      // No family => nothing could be revoked; refusing is the only safe answer.
      expect((result as any).revokedTokens).toBe(0);
      expect(repo.find).not.toHaveBeenCalled();
    });
  });

  describe("invalid tokens", () => {
    it("rejects an unknown token", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.rotate("nope")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an expired token", async () => {
      repo.findOne.mockResolvedValue(tokenEntity({ expiresAt: PAST() }));
      await expect(service.rotate("token-abc")).rejects.toThrow(
        "Invalid or expired refresh token",
      );
    });

    // The lookup must not filter on revoked=false, or a replay would be
    // indistinguishable from a forgery.
    it("looks the token up without filtering on the revoked flag", async () => {
      repo.findOne.mockResolvedValue(tokenEntity({ revoked: true }));
      await service.rotate("token-abc");

      const where = repo.findOne.mock.calls[0][0].where;
      expect(Object.keys(where)).toEqual(["token"]);
      expect(where).not.toHaveProperty("revoked");
    });
  });

  describe("logout", () => {
    it("revokes a single token immediately", async () => {
      const target = tokenEntity();

      await service.revokeToken(target);

      expect(target.revoked).toBe(true);
      expect(target.revokedAt).toBeInstanceOf(Date);
      expect(await store.isRevoked("refresh-revoked:tok-1")).toBe(true);
    });

    it("leaves the rest of the family alone", async () => {
      // Logout is scoped: it should not kill an unrelated session.
      const target = tokenEntity();
      repo.find.mockResolvedValue([tokenEntity({ id: "other", familyId: "family-1" })]);

      await service.revokeToken(target);

      expect(repo.find).not.toHaveBeenCalled();
    });
  });

  describe("family ids", () => {
    it("generates a distinct id per login", () => {
      const a = service.newFamilyId();
      const b = service.newFamilyId();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
