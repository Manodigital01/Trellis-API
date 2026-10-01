import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { UserService } from "./user.service";
import { User, UserRole } from "./entities/user.entity";
import { SensitiveActionAuditService } from "src/infrastructure/audit/sensitive-actions/sensitive-action-audit.service";
import { SensitiveActionStatus } from "src/infrastructure/audit/entities/sensitive-action-event.entity";

const makeUser = (role: UserRole = UserRole.USER): User =>
  ({
    id: "user-1",
    role,
    username: null,
    walletAddress: "0xabc",
    email: null,
    password: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    provenanceRecords: [],
    wallets: [],
    referralCode: null,
    referredById: null,
    referredBy: null,
    referrals: [],
  }) as unknown as User;

const mockRepo = () => ({
  findOne: jest.fn(),
  save: jest.fn(async (u: User) => u),
  find: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  insert: jest.fn(),
});

describe("UserService — role separation (Governance vs KYC)", () => {
  let service: UserService;
  let repo: ReturnType<typeof mockRepo>;
  let sensitiveActionAudit: { recordSensitiveAction: jest.Mock };

  beforeEach(async () => {
    repo = mockRepo();
    sensitiveActionAudit = { recordSensitiveAction: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: SensitiveActionAuditService, useValue: sensitiveActionAudit },
      ],
    }).compile();
    service = module.get<UserService>(UserService);
  });

  describe("assertNoRoleConflict", () => {
    it("throws when assigning KYC_OPERATOR to an ADMIN user", () => {
      expect(() =>
        service.assertNoRoleConflict(UserRole.ADMIN, UserRole.KYC_OPERATOR),
      ).toThrow(BadRequestException);
    });

    it("throws when assigning ADMIN to a KYC_OPERATOR user", () => {
      expect(() =>
        service.assertNoRoleConflict(UserRole.KYC_OPERATOR, UserRole.ADMIN),
      ).toThrow(BadRequestException);
    });

    it("does not throw when assigning same role", () => {
      expect(() =>
        service.assertNoRoleConflict(UserRole.ADMIN, UserRole.ADMIN),
      ).not.toThrow();
    });

    it("does not throw when assigning unrelated roles", () => {
      expect(() =>
        service.assertNoRoleConflict(UserRole.USER, UserRole.ADMIN),
      ).not.toThrow();
    });
  });

  describe("assignRole", () => {
    it("throws BadRequestException when assigning KYC_OPERATOR to ADMIN user", async () => {
      const user = makeUser(UserRole.ADMIN);
      repo.findOne.mockResolvedValue(user);
      await expect(
        service.assignRole("user-1", UserRole.KYC_OPERATOR),
      ).rejects.toThrow(BadRequestException);
      expect(user.role).toBe(UserRole.ADMIN);
      expect(sensitiveActionAudit.recordSensitiveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SensitiveActionStatus.FAILED,
          beforeState: { role: UserRole.ADMIN },
          afterState: { role: UserRole.KYC_OPERATOR },
        }),
      );
    });

    it("throws BadRequestException when assigning ADMIN to KYC_OPERATOR user", async () => {
      repo.findOne.mockResolvedValue(makeUser(UserRole.KYC_OPERATOR));
      await expect(
        service.assignRole("user-1", UserRole.ADMIN),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when user does not exist", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.assignRole("nonexistent", UserRole.ADMIN),
      ).rejects.toThrow(NotFoundException);
    });

    it("successfully assigns ADMIN to a plain USER", async () => {
      const user = makeUser(UserRole.USER);
      repo.findOne.mockResolvedValue(user);
      const result = await service.assignRole("user-1", UserRole.ADMIN);
      expect(result.role).toBe(UserRole.ADMIN);
      expect(sensitiveActionAudit.recordSensitiveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          beforeState: { role: UserRole.USER },
          afterState: { role: UserRole.ADMIN },
          resourceId: "user-1",
        }),
      );
    });

    it("successfully assigns KYC_OPERATOR to a plain USER", async () => {
      const user = makeUser(UserRole.USER);
      repo.findOne.mockResolvedValue(user);
      const result = await service.assignRole("user-1", UserRole.KYC_OPERATOR);
      expect(result.role).toBe(UserRole.KYC_OPERATOR);
    });
  });
});
