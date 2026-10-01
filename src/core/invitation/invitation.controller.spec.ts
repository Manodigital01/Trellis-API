import { Test, TestingModule } from "@nestjs/testing";
import { InvitationController } from "./invitation.controller";
import { InvitationService } from "./invitation.service";
import { Role } from "../../common/guard/roles.enum";

describe("InvitationController", () => {
  let controller: InvitationController;

  const mockInvitationService = {
    create: jest.fn(),
    accept: jest.fn(),
    revoke: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationController],
      providers: [
        {
          provide: InvitationService,
          useValue: mockInvitationService,
        },
      ],
    }).compile();

    controller = module.get<InvitationController>(InvitationController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("create", () => {
    it("should create an invitation", async () => {
      const dto = { email: "test@test.com", role: Role.USER };
      const user = { id: "inviter-1", role: Role.ADMIN };

      mockInvitationService.create.mockResolvedValue({ id: "1" });

      const result = await controller.create(dto, user);
      expect(result).toEqual({ id: "1" });
      expect(mockInvitationService.create).toHaveBeenCalledWith(dto, user.id, user.role);
    });
  });

  describe("accept", () => {
    it("should accept an invitation", async () => {
      mockInvitationService.accept.mockResolvedValue({ id: "1" });

      const result = await controller.accept({ token: "token-123" });
      expect(result).toEqual({ id: "1" });
      expect(mockInvitationService.accept).toHaveBeenCalledWith("token-123");
    });
  });

  describe("revoke", () => {
    it("should revoke an invitation", async () => {
      const user = { id: "inviter-1", role: Role.ADMIN };
      mockInvitationService.revoke.mockResolvedValue({ id: "1" });

      const result = await controller.revoke("1", user);
      expect(result).toEqual({ id: "1" });
      expect(mockInvitationService.revoke).toHaveBeenCalledWith("1", user.id, user.role);
    });
  });
});
