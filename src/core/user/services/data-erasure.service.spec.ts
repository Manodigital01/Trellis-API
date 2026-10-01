import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { NotFoundException } from "@nestjs/common";
import { User } from "../entities/user.entity";
import { DataErasureService } from "./data-erasure.service";

/**
 * Issue #141: a right-to-be-forgotten request must permanently anonymise a
 * user's PII while leaving the protocol's accounting record intact. Both halves
 * matter — erasing too little violates the request, erasing too much destroys
 * balances the protocol is obliged to keep.
 */
describe("DataErasureService (#141)", () => {
  let service: DataErasureService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    softDelete: jest.Mock;
    metadata: { columns: Array<{ propertyName: string }> };
  };

  const userRow = (overrides: Partial<Record<string, any>> = {}) => ({
    id: "user-1",
    username: "alice",
    email: "alice@example.com",
    password: "hash",
    walletAddress: "GABC",
    role: "USER",
    emailVerified: true,
    ...overrides,
  });

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
      metadata: {
        columns: [
          { propertyName: "id" },
          { propertyName: "username" },
          { propertyName: "email" },
          { propertyName: "password" },
          { propertyName: "walletAddress" },
          { propertyName: "role" },
          { propertyName: "emailVerified" },
          { propertyName: "createdAt" },
        ],
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataErasureService,
        { provide: getRepositoryToken(User), useValue: repo },
      ],
    }).compile();

    service = module.get<DataErasureService>(DataErasureService);
  });

  describe("placeholder", () => {
    it("derives a deterministic, non-routable placeholder from the user id", () => {
      const first = DataErasureService.placeholderFor("user-1");
      const second = DataErasureService.placeholderFor("user-1");

      expect(first).toEqual(second);
      expect(first.username).toBe("deleted_user_user-1");
      // .invalid is RFC 2606 reserved, so the address can never be delivered to.
      expect(first.email).toBe("deleted_user_user-1@anonymized.invalid");
    });

    it("distinguishes two users so erased rows cannot collide", () => {
      expect(DataErasureService.placeholderFor("user-1").email).not.toBe(
        DataErasureService.placeholderFor("user-2").email,
      );
    });
  });

  describe("eraseUser", () => {
    it("rewrites email to the anonymized placeholder", async () => {
      repo.findOne.mockResolvedValue(userRow());

      const result = await service.eraseUser("user-1");

      expect(result.anonymizedFields).toContain("email");
      expect(repo.update).toHaveBeenCalledWith(
        { id: "user-1" },
        expect.objectContaining({
          email: "deleted_user_user-1@anonymized.invalid",
        }),
      );
    });

    it("rewrites username to the anonymized placeholder", async () => {
      repo.findOne.mockResolvedValue(userRow());

      await service.eraseUser("user-1");

      expect(repo.update).toHaveBeenCalledWith(
        { id: "user-1" },
        expect.objectContaining({ username: "deleted_user_user-1" }),
      );
    });

    it("nulls the password hash so it cannot be attacked offline", async () => {
      repo.findOne.mockResolvedValue(userRow());

      await service.eraseUser("user-1");

      expect(repo.update).toHaveBeenCalledWith(
        { id: "user-1" },
        expect.objectContaining({ password: null }),
      );
    });

    it("clears email verification, which is meaningless once the address is gone", async () => {
      repo.findOne.mockResolvedValue(userRow());

      await service.eraseUser("user-1");

      expect(repo.update).toHaveBeenCalledWith(
        { id: "user-1" },
        { emailVerified: false },
      );
    });

    // The acceptance criterion: balances are preserved.
    it("never writes the wallet address or role", async () => {
      repo.findOne.mockResolvedValue(userRow());

      await service.eraseUser("user-1");

      for (const call of repo.update.mock.calls) {
        const patch = call[1] as Record<string, unknown>;
        expect(patch).not.toHaveProperty("walletAddress");
        expect(patch).not.toHaveProperty("role");
        expect(patch).not.toHaveProperty("createdAt");
      }
    });

    it("reports which fields it touched and which it preserved", async () => {
      repo.findOne.mockResolvedValue(userRow());

      const result = await service.eraseUser("user-1");

      expect(result.anonymizedFields).toEqual(
        expect.arrayContaining(["username", "email", "password"]),
      );
      expect(result.preservedFields).toEqual(
        expect.arrayContaining(["walletAddress", "role"]),
      );
    });

    it("soft deletes the row so it leaves active listings", async () => {
      repo.findOne.mockResolvedValue(userRow());

      const result = await service.eraseUser("user-1");

      expect(repo.softDelete).toHaveBeenCalledWith({ id: "user-1" });
      expect(result.softDeleted).toBe(true);
    });

    it("can be told not to soft delete, for an already-deleted row", async () => {
      repo.findOne.mockResolvedValue(userRow());

      const result = await service.eraseUser("user-1", { softDelete: false });

      expect(repo.softDelete).not.toHaveBeenCalled();
      expect(result.softDeleted).toBe(false);
    });

    it("does not hard delete, so accounting rows survive", async () => {
      repo.findOne.mockResolvedValue(userRow());

      await service.eraseUser("user-1");

      // The repository is only ever asked to soft delete.
      expect((repo as any).delete).toBeUndefined();
    });

    it("throws for an unknown user", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.eraseUser("nope")).rejects.toThrow(NotFoundException);
    });
  });

  describe("idempotence", () => {
    it("does not rewrite fields that are already the placeholder", async () => {
      const placeholders = DataErasureService.placeholderFor("user-1");
      repo.findOne.mockResolvedValue(
        userRow({
          username: placeholders.username,
          email: placeholders.email,
          password: null,
          emailVerified: false,
        }),
      );

      const result = await service.eraseUser("user-1");

      expect(result.anonymizedFields).toEqual([]);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("leaves a null field alone rather than writing a placeholder into it", async () => {
      repo.findOne.mockResolvedValue(userRow({ phone: null, email: null }));

      const result = await service.eraseUser("user-1");

      expect(result.anonymizedFields).not.toContain("phone");
      expect(result.anonymizedFields).not.toContain("email");
    });

    it("runs twice without changing the result the second time", async () => {
      repo.findOne.mockResolvedValueOnce(userRow()).mockResolvedValueOnce(
        userRow({
          username: "deleted_user_user-1",
          email: "deleted_user_user-1@anonymized.invalid",
          password: null,
          emailVerified: false,
        }),
      );

      const first = await service.eraseUser("user-1");
      const second = await service.eraseUser("user-1");

      expect(first.anonymizedFields.length).toBeGreaterThan(0);
      expect(second.anonymizedFields).toEqual([]);
    });
  });

  describe("schema tolerance", () => {
    it("only rewrites PII columns that exist on the entity", async () => {
      // A field listed as PII but absent from the entity must not produce a
      // write that the database rejects.
      repo.metadata.columns = [
        { propertyName: "id" },
        { propertyName: "email" },
        { propertyName: "walletAddress" },
      ];
      repo.findOne.mockResolvedValue(userRow({ username: undefined, password: undefined }));

      const result = await service.eraseUser("user-1");

      expect(result.anonymizedFields).toEqual(["email"]);
    });

    it("handles an entity with no PII columns at all", async () => {
      repo.metadata.columns = [{ propertyName: "id" }, { propertyName: "walletAddress" }];
      repo.findOne.mockResolvedValue(userRow({ username: null, email: null, password: null }));

      const result = await service.eraseUser("user-1");

      expect(result.anonymizedFields).toEqual([]);
    });
  });

  describe("session revocation", () => {
    it("revokes sessions when a revoker is supplied", async () => {
      const revoker = { revokeAllForUser: jest.fn().mockResolvedValue(3) };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DataErasureService,
          { provide: getRepositoryToken(User), useValue: repo },
          { provide: "SESSION_REVOKER", useValue: revoker },
        ],
      }).compile();

      // The service takes the revoker as an optional constructor parameter
      // rather than by token, so exercise it directly.
      const withRevoker = new DataErasureService(repo as any, revoker);
      repo.findOne.mockResolvedValue(userRow());

      const result = await withRevoker.eraseUser("user-1");

      expect(revoker.revokeAllForUser).toHaveBeenCalledWith("user-1");
      expect(result.revokedSessions).toBe(3);
      void module;
    });

    it("reports zero revoked sessions when no revoker is configured", async () => {
      repo.findOne.mockResolvedValue(userRow());

      const result = await service.eraseUser("user-1");

      expect(result.revokedSessions).toBe(0);
    });
  });

  describe("eraseAllSoftDeleted", () => {
    it("erases previously deleted users that still hold PII", async () => {
      repo.find.mockResolvedValue([userRow({ id: "user-1" }), userRow({ id: "user-2" })]);
      repo.findOne.mockImplementation(async ({ where }: any) =>
        userRow({ id: where.id }),
      );

      const results = await service.eraseAllSoftDeleted();

      expect(results.map((r) => r.userId)).toEqual(["user-1", "user-2"]);
    });

    it("bounds the batch so a large table cannot hold one transaction open", async () => {
      repo.find.mockResolvedValue([]);

      await service.eraseAllSoftDeleted(25);

      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25 }),
      );
    });

    it("continues past one failure rather than abandoning the batch", async () => {
      repo.find.mockResolvedValue([userRow({ id: "user-1" }), userRow({ id: "user-2" })]);
      repo.findOne
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(userRow({ id: "user-2" }));

      const results = await service.eraseAllSoftDeleted();

      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe("user-2");
    });
  });
});
