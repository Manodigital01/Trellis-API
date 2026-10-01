import { Test, TestingModule } from "@nestjs/testing";
import { InvitationService } from "./invitation.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Invitation } from "./entities/invitation.entity";
import { Role } from "../../common/guard/roles.enum";
import { InvitationStatus } from "./enums/invitation-status.enum";
import { ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";

describe("InvitationService", () => {
  let service: InvitationService;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationService,
        {
          provide: getRepositoryToken(Invitation),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<InvitationService>(InvitationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("create", () => {
    it("should successfully create an invitation if role is valid", async () => {
      mockRepository.create.mockReturnValue({ id: "1" });
      mockRepository.save.mockResolvedValue({ id: "1", role: Role.USER });

      const result = await service.create(
        { email: "test@test.com", role: Role.USER },
        "inviter-1",
        Role.ADMIN,
      );

      expect(result.id).toEqual("1");
      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it("should reject role escalation", async () => {
      await expect(
        service.create(
          { email: "test@test.com", role: Role.ADMIN },
          "inviter-1",
          Role.USER,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("accept", () => {
    it("should successfully accept a valid invitation", async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      mockRepository.findOne.mockResolvedValue({
        id: "1",
        token: "valid-token",
        status: InvitationStatus.PENDING,
        expiresAt: futureDate,
      });
      mockRepository.save.mockResolvedValue({
        id: "1",
        status: InvitationStatus.ACCEPTED,
      });

      const result = await service.accept("valid-token");
      expect(result.status).toEqual(InvitationStatus.ACCEPTED);
    });

    it("should fail if invitation is expired", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      mockRepository.findOne.mockResolvedValue({
        id: "1",
        token: "expired-token",
        status: InvitationStatus.PENDING,
        expiresAt: pastDate,
      });

      await expect(service.accept("expired-token")).rejects.toThrow(BadRequestException);
    });

    it("should fail if invitation is revoked", async () => {
      mockRepository.findOne.mockResolvedValue({
        id: "1",
        token: "revoked-token",
        status: InvitationStatus.REVOKED,
      });

      await expect(service.accept("revoked-token")).rejects.toThrow(BadRequestException);
    });
  });

  describe("revoke", () => {
    it("should allow inviter to revoke", async () => {
      mockRepository.findOne.mockResolvedValue({
        id: "1",
        inviterId: "inviter-1",
        status: InvitationStatus.PENDING,
      });
      mockRepository.save.mockResolvedValue({
        id: "1",
        status: InvitationStatus.REVOKED,
      });

      const result = await service.revoke("1", "inviter-1", Role.USER);
      expect(result.status).toEqual(InvitationStatus.REVOKED);
    });

    it("should fail if another non-admin tries to revoke", async () => {
      mockRepository.findOne.mockResolvedValue({
        id: "1",
        inviterId: "inviter-1",
        status: InvitationStatus.PENDING,
      });

      await expect(
        service.revoke("1", "inviter-2", Role.USER),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
