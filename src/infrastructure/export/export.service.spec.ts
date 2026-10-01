import { Test, TestingModule } from "@nestjs/testing";
import { ExportService } from "./export.service";
import { DataExport, ExportStatus } from "./entities/data-export.entity";
import { ExportScope } from "./dto/export.dto";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Repository } from "typeorm";

describe("ExportService", () => {
  let service: ExportService;
  let mockExportRepo: jest.Mocked<Repository<DataExport>>;

  beforeEach(async () => {
    const mockRepo = {
      create: jest.fn().mockImplementation((dto) => ({ id: "export_123", ...dto })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: "export_123", ...entity })),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportService,
        {
          provide: getRepositoryToken(DataExport),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<ExportService>(ExportService);
    mockExportRepo = mockRepo as unknown as jest.Mocked<Repository<DataExport>>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("createExport", () => {
    it("should create an export with default values", async () => {
      const mockExport = {
        id: "export_123",
        userId: "user_123",
        scope: ExportScope.USER_DATA,
        format: "json",
        schemaVersion: "1.0.0",
        status: ExportStatus.PENDING,
        expiresAt: new Date(),
        createdAt: new Date(),
        filters: {},
      };

      mockExportRepo.create.mockReturnValue(mockExport as any);
      mockExportRepo.save.mockResolvedValue(mockExport as any);

      const result = await service.createExport("user_123", {
        scope: ExportScope.USER_DATA,
      });

      expect(result).toBeDefined();
      expect(result.id).toBe("export_123");
      expect(result.status).toBe(ExportStatus.PENDING);
      expect(mockExportRepo.save).toHaveBeenCalled();
    });

    it("should apply custom retention days", async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);

      const result = await service.createExport("user_123", {
        scope: ExportScope.USER_DATA,
        retentionDays: 30,
      });

      expect(result.expiresAt.getDate()).toBe(futureDate.getDate());
    });

    it("should cap retention days at maximum", async () => {
      const result = await service.createExport("user_123", {
        scope: ExportScope.USER_DATA,
        retentionDays: 200,
      });

      // Should be capped at 90 days
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + 90);
      expect(result.expiresAt.getDate()).toBe(maxDate.getDate());
    });
  });

  describe("getExport", () => {
    it("should return an export by ID", async () => {
      const mockExport = {
        id: "export_123",
        userId: "user_123",
        status: ExportStatus.COMPLETED,
        scope: ExportScope.USER_DATA,
        format: "json",
        schemaVersion: "1.0.0",
        expiresAt: new Date(),
        createdAt: new Date(),
        filters: {},
        downloadUrl: "data:application/json;base64,...",
      };

      mockExportRepo.findOne.mockResolvedValue(mockExport as any);

      const result = await service.getExport("user_123", "export_123");
      expect(result).toBeDefined();
      expect(result.id).toBe("export_123");
    });

    it("should throw NotFoundException for non-existent export", async () => {
      mockExportRepo.findOne.mockResolvedValue(null);

      await expect(service.getExport("user_123", "non_existent")).rejects.toThrow("Export not found");
    });

    it("should throw ForbiddenException for unauthorized user", async () => {
      const mockExport = {
        id: "export_123",
        userId: "user_456",
        status: ExportStatus.COMPLETED,
        scope: ExportScope.USER_DATA,
        format: "json",
        schemaVersion: "1.0.0",
        expiresAt: new Date(),
        createdAt: new Date(),
        filters: {},
      };

      mockExportRepo.findOne.mockResolvedValue(mockExport as any);

      await expect(service.getExport("user_123", "export_123")).rejects.toThrow("You do not have access to this export");
    });
  });

  describe("listExports", () => {
    it("should return exports for a user", async () => {
      const mockExports = [
        { id: "export_1", userId: "user_123", status: ExportStatus.COMPLETED, createdAt: new Date() },
        { id: "export_2", userId: "user_123", status: ExportStatus.PENDING, createdAt: new Date() },
      ];

      mockExportRepo.find.mockResolvedValue(mockExports as any);

      const result = await service.listExports("user_123");
      expect(result).toHaveLength(2);
    });
  });

  describe("expireOldExports", () => {
    it("should delete expired exports", async () => {
      mockExportRepo.createQueryBuilder.mockReturnValue({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      } as any);

      const count = await service.expireOldExports();
      expect(count).toBe(5);
    });
  });
});
