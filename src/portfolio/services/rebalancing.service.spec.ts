import { Test, TestingModule } from "@nestjs/testing";
import { RebalancingService } from "./rebalancing.service";
import { TradingTransactionService } from "src/investment/portfolio/services/trading-transaction.service";

describe("RebalancingService (portfolio)", () => {
  let service: RebalancingService;
  let mockTradingService: jest.Mocked<TradingTransactionService>;

  beforeEach(async () => {
    mockTradingService = {
      executeTrade: jest.fn(),
      processTrade: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RebalancingService,
        { provide: TradingTransactionService, useValue: mockTradingService },
      ],
    }).compile();

    service = module.get<RebalancingService>(RebalancingService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("Issue #13: calculateRebalancingRecommendations (Table-Driven Tests)", () => {
    interface TestCase {
      name: string;
      targetAllocations: Record<string, number>;
      holdings: Record<string, { amount: number; price: number }>;
      threshold?: number;
      expectedTradeCount: number;
      expectedAssets?: string[];
    }

    const testCases: TestCase[] = [
      {
        name: "already balanced portfolio",
        targetAllocations: { BTC: 50, ETH: 50 },
        holdings: {
          BTC: { amount: 1, price: 50000 },
          ETH: { amount: 25, price: 2000 },
        },
        threshold: 5,
        expectedTradeCount: 0,
      },
      {
        name: "single asset drifted above threshold",
        targetAllocations: { BTC: 50, ETH: 50 },
        holdings: {
          BTC: { amount: 1.4, price: 50000 }, // $70k (70%)
          ETH: { amount: 15, price: 2000 },  // $30k (30%) - drift 20% > 5%
        },
        threshold: 5,
        expectedTradeCount: 2,
        expectedAssets: ["BTC", "ETH"],
      },
      {
        name: "all assets drifted above threshold",
        targetAllocations: { BTC: 40, ETH: 40, XLM: 20 },
        holdings: {
          BTC: { amount: 1.2, price: 50000 }, // $60k (60%)
          ETH: { amount: 10, price: 2000 },  // $20k (20%)
          XLM: { amount: 200000, price: 0.1 },// $20k (20%)
        },
        threshold: 5,
        expectedTradeCount: 2, // BTC sell, ETH buy
      },
      {
        name: "drift below threshold",
        targetAllocations: { BTC: 50, ETH: 50 },
        holdings: {
          BTC: { amount: 1.04, price: 50000 }, // $52k (52%)
          ETH: { amount: 24, price: 2000 },   // $48k (48%) - drift 2% < 5%
        },
        threshold: 5,
        expectedTradeCount: 0,
      },
      {
        name: "empty portfolio",
        targetAllocations: { BTC: 50, ETH: 50 },
        holdings: {},
        threshold: 5,
        expectedTradeCount: 0,
      },
    ];

    testCases.forEach((tc) => {
      it(`should handle scenario: ${tc.name}`, async () => {
        const portfolioId = `portfolio-${tc.name.replace(/\s+/g, "-")}`;
        await service.setTargetAllocations(portfolioId, tc.targetAllocations);
        await service.setHoldings(portfolioId, tc.holdings);

        const recommendations = await service.getRebalancingRecommendations(
          portfolioId,
          tc.threshold,
        );

        expect(recommendations.length).toBe(tc.expectedTradeCount);
        if (tc.expectedAssets) {
          const recAssets = recommendations.map((r) => r.asset);
          tc.expectedAssets.forEach((asset) => {
            expect(recAssets).toContain(asset);
          });
        }
      });
    });

    it("should filter out uneconomic trades below minimum trade size or trading fee", async () => {
      const portfolioId = "p-uneconomic";
      service.setMinTradeSize(50); // $50 min trade size
      service.setTradingFee(5);

      await service.setTargetAllocations(portfolioId, { BTC: 50, ETH: 50 });
      await service.setHoldings(portfolioId, {
        BTC: { amount: 1.0006, price: 50000 }, // $50,030 (50.015%)
        ETH: { amount: 24.985, price: 2000 }, // $49,970 (49.985%)
      });

      const recommendations = await service.getRebalancingRecommendations(portfolioId, 0.01);
      expect(recommendations).toHaveLength(0);
    });
  });

  describe("Issue #14: executeRebalancing", () => {
    it("should execute dry-run mode without submitting actual trades", async () => {
      const portfolioId = "p-dryrun";
      await service.setTargetAllocations(portfolioId, { BTC: 50, ETH: 50 });
      await service.setHoldings(portfolioId, {
        BTC: { amount: 1.4, price: 50000 },
        ETH: { amount: 15, price: 2000 },
      });

      const result = await service.executeRebalancing(portfolioId, true);

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.executedTrades.length).toBeGreaterThan(0);
      expect(mockTradingService.executeTrade).not.toHaveBeenCalled();
      expect(result.resultingAllocation).toEqual({ BTC: 50, ETH: 50 });
    });

    it("should execute full rebalancing successfully", async () => {
      const portfolioId = "p-fullsuccess";
      await service.setTargetAllocations(portfolioId, { BTC: 50, ETH: 50 });
      await service.setHoldings(portfolioId, {
        BTC: { amount: 1.4, price: 50000 },
        ETH: { amount: 15, price: 2000 },
      });

      mockTradingService.executeTrade.mockResolvedValue({
        success: true,
        transactionHash: "tx-success-123",
        executedQuantity: 0.2,
        executedPrice: 50000,
        status: "CONFIRMED",
        timestamp: new Date().toISOString(),
      });

      const result = await service.executeRebalancing(portfolioId, false);

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(result.executedTrades).toHaveLength(2);
      expect(result.failedTrades).toHaveLength(0);
      expect(mockTradingService.executeTrade).toHaveBeenCalledTimes(2);
    });

    it("should handle partial failure explicitly and report resulting allocation", async () => {
      const portfolioId = "p-partialfail";
      await service.setTargetAllocations(portfolioId, { BTC: 50, ETH: 50 });
      await service.setHoldings(portfolioId, {
        BTC: { amount: 1.4, price: 50000 },
        ETH: { amount: 15, price: 2000 },
      });

      // First trade succeeds, second fails
      mockTradingService.executeTrade
        .mockResolvedValueOnce({
          success: true,
          transactionHash: "tx-btc-ok",
          executedQuantity: 0.2,
          executedPrice: 50000,
          status: "CONFIRMED",
          timestamp: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          success: false,
          executedQuantity: 0,
          executedPrice: 2000,
          status: "FAILED",
          errorReason: "SLIPPAGE_EXCEEDED",
          timestamp: new Date().toISOString(),
        });

      const result = await service.executeRebalancing(portfolioId, false);

      expect(result.success).toBe(false); // partial failure
      expect(result.executedTrades).toHaveLength(1);
      expect(result.failedTrades).toHaveLength(1);
      expect(result.failedTrades[0].error).toBe("SLIPPAGE_EXCEEDED");
      expect(result.resultingAllocation).toBeDefined();
    });

    it("should enforce idempotency and prevent double execution when clientReference is provided", async () => {
      const portfolioId = "p-idempotent";
      await service.setTargetAllocations(portfolioId, { BTC: 50, ETH: 50 });
      await service.setHoldings(portfolioId, {
        BTC: { amount: 1.4, price: 50000 },
        ETH: { amount: 15, price: 2000 },
      });

      mockTradingService.executeTrade.mockResolvedValue({
        success: true,
        transactionHash: "tx-idempotent-1",
        executedQuantity: 0.2,
        executedPrice: 50000,
        status: "CONFIRMED",
        timestamp: new Date().toISOString(),
      });

      const firstRun = await service.executeRebalancing(portfolioId, false, "ref-abc-123");
      const secondRun = await service.executeRebalancing(portfolioId, false, "ref-abc-123");

      expect(firstRun).toBe(secondRun);
      expect(mockTradingService.executeTrade).toHaveBeenCalledTimes(2); // Only called during first run
    });
  });
});
