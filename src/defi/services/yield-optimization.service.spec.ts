import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  StrategyStatus,
  StrategyType,
  DeFiYieldStrategy,
} from "../entities/defi-yield-strategy.entity";
import { DeFiPosition, DeFiProtocol } from "../entities/defi-position.entity";
import { ProtocolRegistry } from "../protocols/protocol-registry";
import { YieldOptimizationService } from "./yield-optimization.service";

function strategy(overrides: Partial<DeFiYieldStrategy> = {}) {
  return {
    id: "strat-1",
    user_id: "user-1",
    name: "USDC lending",
    strategy_type: StrategyType.STABLE_YIELD,
    status: StrategyStatus.ACTIVE,
    protocols: ["aave"],
    tokens: ["USDC"],
    allocation_weights: {},
    current_value: 10_000,
    current_apy: 8,
    accumulated_yield: 0,
    auto_compound_enabled: true,
    last_compounded_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as DeFiYieldStrategy;
}

function position(overrides: Partial<DeFiPosition> = {}) {
  return {
    id: "pos-1",
    protocol: DeFiProtocol.AAVE,
    contract_address: "0xpool",
    wallet_address: "0xabc",
    token_symbol: "USDC",
    current_amount: 10_000,
    ...overrides,
  } as unknown as DeFiPosition;
}

describe("YieldOptimizationService", () => {
  let service: YieldOptimizationService;
  let strategyRepo: Record<string, jest.Mock>;
  let positionRepo: Record<string, jest.Mock>;
  let protocolRegistry: Record<string, jest.Mock>;
  let mockAdapter: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockAdapter = {
      name: "aave",
      supportedChains: ["ethereum"],
      getAPY: jest.fn().mockResolvedValue(8),
      getProtocolMetrics: jest
        .fn()
        .mockResolvedValue({
          tvl: 5e9,
          audits: ["Sigma"],
          apy: 8,
          insurance: true,
        }),
      getRewards: jest
        .fn()
        .mockResolvedValue([
          { token: "USDC", amount: 10, valueUSD: 10, apy: 8, claimable: true },
        ]),
    };

    strategyRepo = {
      findOne: jest.fn().mockResolvedValue(strategy()),
      save: jest.fn().mockImplementation((s) => Promise.resolve(s)),
    };
    positionRepo = {
      find: jest.fn().mockResolvedValue([position()]),
    };
    protocolRegistry = {
      getAdapter: jest.fn().mockReturnValue(mockAdapter),
      getAllAdapters: jest.fn().mockReturnValue([mockAdapter]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        YieldOptimizationService,
        {
          provide: getRepositoryToken(DeFiYieldStrategy),
          useValue: strategyRepo,
        },
        { provide: getRepositoryToken(DeFiPosition), useValue: positionRepo },
        { provide: ProtocolRegistry, useValue: protocolRegistry },
      ],
    }).compile();

    service = module.get<YieldOptimizationService>(YieldOptimizationService);
  });

  describe("calculateImpermanentLoss", () => {
    it("is zero when the price ratio is unchanged", () => {
      expect(service.calculateImpermanentLoss(1)).toBe(0);
    });

    it("matches the reference value for P = 4 (2*sqrt(P)/(1+P) - 1)", () => {
      expect(service.calculateImpermanentLoss(4)).toBeCloseTo(-0.2, 12);
    });

    it("is symmetric around P = 1 (P = 0.25 loses the same as P = 4)", () => {
      expect(service.calculateImpermanentLoss(0.25)).toBeCloseTo(-0.2, 12);
    });

    it("matches the reference value for P = 2.25", () => {
      expect(service.calculateImpermanentLoss(2.25)).toBeCloseTo(
        -0.0769230769,
        9,
      );
    });

    it("matches the reference value for P = 10", () => {
      expect(service.calculateImpermanentLoss(10)).toBeCloseTo(
        -0.4250404254,
        9,
      );
    });

    it("approaches -100% as the ratio goes to infinity", () => {
      expect(service.calculateImpermanentLoss(100)).toBeCloseTo(
        -0.801980198,
        9,
      );
      expect(service.calculateImpermanentLoss(1e12)).toBeCloseTo(-1, 5);
    });

    it("loses everything when one side of the pool goes to zero", () => {
      expect(service.calculateImpermanentLoss(0)).toBe(-1);
    });

    it("grows monotonically worse as the ratio diverges", () => {
      const ratios = [1.25, 1.5, 2, 4, 8, 16];
      const losses = ratios.map((p) => service.calculateImpermanentLoss(p));

      for (let i = 1; i < losses.length; i++) {
        expect(losses[i]).toBeLessThan(losses[i - 1]);
      }
    });

    it("ignores an unusable ratio instead of returning NaN", () => {
      expect(service.calculateImpermanentLoss(Number.NaN)).toBe(0);
      expect(service.calculateImpermanentLoss(-4)).toBe(0);
    });
  });

  describe("calculateCompoundingPlan", () => {
    it("reports the break-even interval where rewards cover the gas", () => {
      // $10k at 8% earns ~$0.0913/h, so $5 of gas is covered after ~55h.
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 8,
        gasCostPerCompoundUsd: 5,
      });

      expect(plan.breakEvenIntervalHours).toBeCloseTo(54.75, 1);
    });

    it("subtracts gas drag and impermanent loss from the gross APY", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 8,
        gasCostPerCompoundUsd: 5,
        annualVolatility: 0.5,
      });

      expect(plan.netApy).toBeLessThan(plan.grossApy);
      expect(plan.gasDragApy).toBeGreaterThan(0);
      expect(plan.impermanentLossApy).toBeLessThan(0);
      expect(plan.netApy).toBeCloseTo(
        plan.grossApy + plan.impermanentLossApy - plan.gasDragApy,
        2,
      );
    });

    it("picks the longest interval when gas is the binding cost", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 8,
        gasCostPerCompoundUsd: 5,
        minIntervalHours: 6,
        maxIntervalHours: 720,
      });

      expect(plan.optimalIntervalHours).toBe(720);
      expect(plan.netApy).toBeCloseTo(4.67, 2);
      expect(plan.profitable).toBe(true);
    });

    it("shortens the interval when the per-compound IL limit binds", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 8,
        gasCostPerCompoundUsd: 5,
        maxImpermanentLossPerCompoundPercent: 0.05,
      });

      expect(plan.optimalIntervalHours).toBeLessThan(720);
      expect(plan.optimalIntervalHours).toBeGreaterThan(
        plan.breakEvenIntervalHours,
      );
    });

    it("returns no break-even interval when the position earns nothing", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 0,
      });

      expect(plan.breakEvenIntervalHours).toBeNull();
      expect(plan.netApy).toBeLessThan(0);
      expect(plan.profitable).toBe(false);
    });

    it("flags a position too small for gas to ever pay for itself", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 200,
        apy: 8,
        gasCostPerCompoundUsd: 5,
      });

      expect(plan.breakEvenIntervalHours).toBeGreaterThan(720);
      expect(plan.netApy).toBeLessThan(0);
      expect(plan.profitable).toBe(false);
    });

    it("uses an observed price ratio instead of the volatility model", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 8,
        gasCostPerCompoundUsd: 5,
        priceRatio: 4,
      });

      // A 4x divergence is -20% per compound, which nothing survives.
      expect(plan.impermanentLossPercent).toBeCloseTo(-20, 6);
      expect(plan.profitable).toBe(false);
    });

    it("always returns a scored candidate set", () => {
      const plan = service.calculateCompoundingPlan({
        positionValueUsd: 10_000,
        apy: 8,
        steps: 8,
      });

      expect(plan.candidates.length).toBeGreaterThan(0);
      for (const candidate of plan.candidates) {
        expect(candidate.intervalHours).toBeGreaterThan(0);
        expect(Number.isFinite(candidate.netApy)).toBe(true);
      }
    });
  });

  describe("evaluateCompoundingTrigger", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");

    it("compounds when the interval elapsed and rewards beat gas", () => {
      const trigger = service.evaluateCompoundingTrigger({
        lastCompoundedAt: new Date(
          now.getTime() - 7 * 24 * 60 * 60 * 1000,
        ),
        apy: 8,
        positionValueUsd: 10_000,
        pendingRewardsUsd: 120,
        gasCostPerCompoundUsd: 5,
        recommendedIntervalHours: 24,
        now,
      });

      expect(trigger.shouldCompound).toBe(true);
      expect(trigger.reason).toBe("ready");
      expect(trigger.elapsedHours).toBe(168);
    });

    it("waits when the interval has not elapsed", () => {
      const trigger = service.evaluateCompoundingTrigger({
        lastCompoundedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        apy: 8,
        positionValueUsd: 10_000,
        pendingRewardsUsd: 120,
        recommendedIntervalHours: 24,
        now,
      });

      expect(trigger.shouldCompound).toBe(false);
      expect(trigger.reason).toBe("interval_not_elapsed");
      expect(trigger.nextEligibleAt).toEqual(
        new Date(now.getTime() + 22 * 60 * 60 * 1000),
      );
    });

    it("refuses to compound rewards smaller than the gas", () => {
      const trigger = service.evaluateCompoundingTrigger({
        lastCompoundedAt: new Date(
          now.getTime() - 7 * 24 * 60 * 60 * 1000,
        ),
        apy: 8,
        positionValueUsd: 10_000,
        pendingRewardsUsd: 1.2,
        gasCostPerCompoundUsd: 5,
        recommendedIntervalHours: 24,
        now,
      });

      expect(trigger.shouldCompound).toBe(false);
      expect(trigger.reason).toBe("rewards_below_gas");
    });

    it("does nothing without a position", () => {
      const trigger = service.evaluateCompoundingTrigger({
        lastCompoundedAt: null,
        apy: 8,
        positionValueUsd: 0,
        pendingRewardsUsd: 100,
        now,
      });

      expect(trigger.shouldCompound).toBe(false);
      expect(trigger.reason).toBe("no_position");
      expect(trigger.elapsedHours).toBeNull();
    });

    it("is ready on a first run when the rewards cover the gas", () => {
      const trigger = service.evaluateCompoundingTrigger({
        lastCompoundedAt: null,
        apy: 8,
        positionValueUsd: 10_000,
        pendingRewardsUsd: 100,
        gasCostPerCompoundUsd: 5,
        now,
      });

      expect(trigger.shouldCompound).toBe(true);
      expect(trigger.nextEligibleAt).toBeNull();
    });
  });

  describe("findHighestYieldOpportunities", () => {
    it("reports net APY alongside the nominal figure", async () => {
      const opportunities = await service.findHighestYieldOpportunities(
        ["USDC"],
        "ethereum",
        { positionValueUsd: 10_000, gasCostPerCompoundUsd: 5 },
      );

      const [usdc] = opportunities.get("USDC");
      expect(usdc.apy).toBe(8);
      // One compound every 30 days at 50% annual volatility costs ~0.22%.
      expect(usdc.impermanentLossPercent).toBeCloseTo(-0.2239, 3);
      expect(usdc.impermanentLossApy).toBeLessThan(usdc.impermanentLossPercent);
      expect(usdc.gasDragApy).toBeGreaterThan(0);
      expect(usdc.netApy).toBeLessThan(usdc.apy);
      expect(usdc.optimalCompoundingIntervalHours).toBe(720);
    });
  });

  describe("optimizeYieldAllocation", () => {
    it("returns estimated IL and net APY alongside the nominal APY", async () => {
      const result = await service.optimizeYieldAllocation(
        "user-1",
        30_000,
        StrategyType.HIGHEST_YIELD,
        {
          preferredTokens: ["USDC"],
          positionValueUsd: 10_000,
          gasCostPerCompoundUsd: 5,
          annualVolatility: 0.5,
        },
      );

      expect(result.expectedApy).toBeCloseTo(8, 6);
      expect(result.estimatedImpermanentLossPercent).toBeCloseTo(-0.2239, 3);
      expect(result.impermanentLossApy).toBeCloseTo(-2.72, 2);
      expect(result.gasDragApy).toBeGreaterThan(0);
      expect(result.netApy).toBeLessThan(result.expectedApy);
      expect(result.expectedNetYield).toBeCloseTo(
        result.totalCapital * (result.netApy / 100),
        6,
      );
      expect(result.recommendedCompoundingIntervalHours).toBe(720);
      expect(result.allocations[0].netApy).toBeCloseTo(result.netApy, 6);
    });

    it("reports a negative net yield for a high-risk allocation", async () => {
      mockAdapter.getAPY.mockResolvedValue(0.5);
      mockAdapter.getProtocolMetrics.mockResolvedValue({
        tvl: 1_000_000,
        audits: [],
        apy: 0.5,
      });

      const result = await service.optimizeYieldAllocation(
        "user-1",
        500,
        StrategyType.HIGHEST_YIELD,
        { preferredTokens: ["USDC"], positionValueUsd: 500 },
      );

      expect(result.expectedApy).toBeCloseTo(0.5, 6);
      expect(result.netApy).toBeLessThan(0);
    });
  });

  describe("getCompoundingPlan", () => {
    it("builds a plan from the strategy's own value and APY", async () => {
      const plan = await service.getCompoundingPlan("strat-1");

      expect(plan.grossApy).toBe(8);
      expect(plan.optimalIntervalHours).toBe(720);
      expect(plan.breakEvenIntervalHours).toBeCloseTo(54.75, 1);
      expect(plan.profitable).toBe(true);
    });

    it("lets the caller override the economics", async () => {
      const plan = await service.getCompoundingPlan("strat-1", {
        gasCostPerCompoundUsd: 0,
      });

      expect(plan.gasDragApy).toBe(0);
      expect(plan.netApy).toBeGreaterThan(8 - 3);
    });

    it("throws when the strategy does not exist", async () => {
      strategyRepo.findOne.mockResolvedValue(null);

      await expect(service.getCompoundingPlan("missing")).rejects.toThrow(
        "Strategy not found",
      );
    });
  });

  describe("autoCompoundRewards", () => {
    it("compounds claimable rewards and stamps the compound time", async () => {
      const result = await service.autoCompoundRewards("strat-1");

      expect(result.skipped).toBe(false);
      expect(result.totalCompounded).toBe(10);
      expect(result.compoundingCount).toBe(1);
      expect(strategyRepo.save).toHaveBeenCalled();
    });
  });

  describe("runScheduledCompounding", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");

    it("compounds when the interval has elapsed and rewards clear gas", async () => {
      strategyRepo.findOne.mockResolvedValue(
        strategy({
          last_compounded_at: new Date("2025-12-01T00:00:00.000Z"),
        }),
      );

      const result = await service.runScheduledCompounding("strat-1", { now });

      expect(result.skipped).toBe(false);
      expect(result.totalCompounded).toBe(10);
      expect(result.trigger.reason).toBe("ready");
      expect(strategyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          accumulated_yield: 10,
          last_compounded_at: now,
        }),
      );
    });

    it("skips when the interval has not elapsed", async () => {
      strategyRepo.findOne.mockResolvedValue(
        strategy({
          last_compounded_at: new Date("2026-01-09T23:00:00.000Z"),
        }),
      );

      const result = await service.runScheduledCompounding("strat-1", { now });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("interval_not_elapsed");
      expect(result.totalCompounded).toBe(0);
      expect(strategyRepo.save).not.toHaveBeenCalled();
    });

    it("skips when the rewards do not cover the gas", async () => {
      mockAdapter.getRewards.mockResolvedValue([
        { token: "USDC", amount: 0.1, valueUSD: 0.1, apy: 8, claimable: true },
      ]);
      strategyRepo.findOne.mockResolvedValue(
        strategy({
          last_compounded_at: new Date("2025-12-01T00:00:00.000Z"),
        }),
      );

      const result = await service.runScheduledCompounding("strat-1", { now });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("rewards_below_gas");
    });

    it("skips when auto-compounding is switched off", async () => {
      strategyRepo.findOne.mockResolvedValue(
        strategy({ auto_compound_enabled: false }),
      );

      const result = await service.runScheduledCompounding("strat-1", { now });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("auto_compound_disabled");
    });

    it("compounds a disabled strategy when forced", async () => {
      strategyRepo.findOne.mockResolvedValue(
        strategy({
          auto_compound_enabled: false,
          last_compounded_at: new Date("2025-12-01T00:00:00.000Z"),
        }),
      );

      const result = await service.runScheduledCompounding("strat-1", {
        force: true,
        now,
      });

      expect(result.skipped).toBe(false);
    });

    it("reads the rewards once per run", async () => {
      strategyRepo.findOne.mockResolvedValue(
        strategy({
          last_compounded_at: new Date("2025-12-01T00:00:00.000Z"),
        }),
      );

      await service.runScheduledCompounding("strat-1", { now });

      expect(mockAdapter.getRewards).toHaveBeenCalledTimes(1);
    });
  });
});
