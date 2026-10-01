import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { InvariantMonitorService } from "./invariant-monitor.service";
import { InvariantReportEntity } from "./entities/invariant-report.entity";
import { InvariantCategory, InvariantStatus } from "./invariant.types";
import { User } from "src/core/user/entities/user.entity";
import { Wallet } from "src/core/auth/entities/wallet.entity";
import { Portfolio } from "src/investment/portfolio/entities/portfolio.entity";
import { PortfolioAsset } from "src/investment/portfolio/entities/portfolio-asset.entity";
import { Transaction } from "src/investment/portfolio/entities/transaction.entity";
import { Role } from "src/common/guard/roles.enum";

describe("InvariantMonitorService", () => {
  let service: InvariantMonitorService;

  const createMockQueryBuilder = (results: any[] = []) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(results),
    getRawMany: jest.fn().mockResolvedValue(results),
  });

  const mockReportRepo = {
    create: jest.fn((dto) => ({ ...dto })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };

  let mockUserRepo: any;
  let mockWalletRepo: any;
  let mockPortfolioRepo: any;
  let mockAssetRepo: any;
  let mockTransactionRepo: any;

  beforeEach(async () => {
    mockUserRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder()),
      count: jest.fn().mockResolvedValue(2),
    };
    mockWalletRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder()),
    };
    mockPortfolioRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder()),
    };
    mockAssetRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder()),
    };
    mockTransactionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(createMockQueryBuilder()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvariantMonitorService,
        { provide: getRepositoryToken(InvariantReportEntity), useValue: mockReportRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Wallet), useValue: mockWalletRepo },
        { provide: getRepositoryToken(Portfolio), useValue: mockPortfolioRepo },
        { provide: getRepositoryToken(PortfolioAsset), useValue: mockAssetRepo },
        { provide: getRepositoryToken(Transaction), useValue: mockTransactionRepo },
      ],
    }).compile();

    service = module.get<InvariantMonitorService>(InvariantMonitorService);
    service.onModuleInit();
    jest.clearAllMocks();
  });

  describe("invariant registration", () => {
    it("should register all invariants", () => {
      const invariants = service.getRegisteredInvariants();
      expect(invariants.length).toBeGreaterThanOrEqual(8);
    });

    it("should cover all categories", () => {
      const invariants = service.getRegisteredInvariants();
      const categories = new Set(invariants.map((i) => i.category));
      expect(categories.has(InvariantCategory.FUNDS)).toBe(true);
      expect(categories.has(InvariantCategory.OWNERSHIP)).toBe(true);
      expect(categories.has(InvariantCategory.LIFECYCLE)).toBe(true);
      expect(categories.has(InvariantCategory.AUTHORIZATION)).toBe(true);
    });
  });

  describe("funds invariant: negative asset", () => {
    it("should detect negative asset quantities", async () => {
      mockAssetRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder([{ id: "asset-1", quantity: -5 }]),
      );

      const result = await service.runSingleCheck(
        "funds.portfolio_asset_non_negative",
      );
      expect(result.status).toBe(InvariantStatus.FAIL);
      expect(result.affectedRecordIds).toContain("asset-1");
    });

    it("should pass when all assets are non-negative", async () => {
      mockAssetRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder([]),
      );

      const result = await service.runSingleCheck(
        "funds.portfolio_asset_non_negative",
      );
      expect(result.status).toBe(InvariantStatus.PASS);
    });
  });

  describe("ownership invariant: orphan portfolio", () => {
    it("should detect portfolios without valid owners", async () => {
      mockPortfolioRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder([{ id: "portfolio-orphan" }]),
      );

      const result = await service.runSingleCheck(
        "ownership.portfolio_has_owner",
      );
      expect(result.status).toBe(InvariantStatus.FAIL);
      expect(result.affectedRecordIds).toContain("portfolio-orphan");
    });
  });

  describe("lifecycle invariant: future dates", () => {
    it("should detect future creation dates", async () => {
      mockUserRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder([{ id: "user-future" }]),
      );

      const result = await service.runSingleCheck("lifecycle.no_future_dates");
      expect(result.status).toBe(InvariantStatus.FAIL);
      expect(result.affectedRecordIds).toContain("user-future");
    });
  });

  describe("authorization invariant: admin count", () => {
    it("should warn when admin count exceeds threshold", async () => {
      mockUserRepo.count.mockResolvedValue(15);

      const result = await service.runSingleCheck("auth.admin_count_bounded");
      expect(result.status).toBe(InvariantStatus.WARN);
      expect(result.metadata?.adminCount).toBe(15);
    });

    it("should pass when admin count is within bounds", async () => {
      mockUserRepo.count.mockResolvedValue(3);

      const result = await service.runSingleCheck("auth.admin_count_bounded");
      expect(result.status).toBe(InvariantStatus.PASS);
    });
  });

  describe("authorization invariant: inactive admin", () => {
    it("should detect stale admin accounts", async () => {
      mockUserRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder([{ id: "stale-admin" }]),
      );

      const result = await service.runSingleCheck("auth.inactive_admin_check");
      expect(result.status).toBe(InvariantStatus.WARN);
      expect(result.affectedRecordIds).toContain("stale-admin");
    });
  });

  describe("runAllChecks", () => {
    it("should generate a report with all checks", async () => {
      const report = await service.runAllChecks("test-user");
      expect(report.totalChecks).toBeGreaterThanOrEqual(8);
      expect(report.reportId).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(mockReportRepo.save).toHaveBeenCalled();
    });

    it("should report mixed pass/fail correctly", async () => {
      // Make one check fail
      mockAssetRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder([{ id: "bad-asset" }]),
      );

      const report = await service.runAllChecks("test-user");
      expect(report.passed + report.failed + report.warnings + report.errors).toBe(
        report.totalChecks,
      );
    });
  });

  describe("runChecksByCategory", () => {
    it("should only run checks for the specified category", async () => {
      const report = await service.runChecksByCategory(
        InvariantCategory.FUNDS,
        "test-user",
      );
      for (const result of report.results) {
        expect(result.category).toBe(InvariantCategory.FUNDS);
      }
    });
  });

  describe("runSingleCheck", () => {
    it("should return error for unknown invariant", async () => {
      const result = await service.runSingleCheck("nonexistent.check");
      expect(result.status).toBe(InvariantStatus.ERROR);
    });
  });
});
