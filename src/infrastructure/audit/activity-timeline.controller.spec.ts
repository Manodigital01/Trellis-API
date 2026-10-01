import { Test, TestingModule } from "@nestjs/testing";
import { ActivityTimelineController } from "./activity-timeline.controller";
import { AuditLogService } from "./audit-log.service";
import { AuditLogVisibility, AuditLogAction } from "./entities/audit-log.entity";
import { JwtAuthGuard } from "../../core/auth/jwt.guard";

describe("ActivityTimelineController", () => {
  let controller: ActivityTimelineController;
  let service: AuditLogService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActivityTimelineController],
      providers: [
        {
          provide: AuditLogService,
          useValue: {
            getTimeline: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ActivityTimelineController>(ActivityTimelineController);
    service = module.get<AuditLogService>(AuditLogService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("should fetch timeline for authenticated user", async () => {
    const mockData = {
      data: [
        {
          id: "1",
          userId: "user-1",
          visibility: AuditLogVisibility.PUBLIC,
          action: AuditLogAction.LOGIN,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
      nextCursor: null,
    };
    (service.getTimeline as jest.Mock).mockResolvedValue(mockData);

    const result = await controller.getTimeline({ user: { id: "user-1" } }, 1, 20);

    expect(service.getTimeline).toHaveBeenCalledWith("user-1", 1, 20, undefined);
    expect(result).toEqual(mockData);
  });
});
