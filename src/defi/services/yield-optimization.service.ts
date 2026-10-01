import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  DeFiYieldStrategy,
  StrategyType,
} from "../entities/defi-yield-strategy.entity";
import { DeFiPosition } from "../entities/defi-position.entity";
import { ProtocolRegistry } from "../protocols/protocol-registry";
import {
  ProtocolAdapter,
  PositionData,
} from "../protocols/protocol-adapter.interface";

/** Hours in a year, used to annualise rewards, gas and divergence. */
const HOURS_PER_YEAR = 8760;

/** Position size assumed when the caller does not know its own. */
const DEFAULT_POSITION_VALUE_USD = 10_000;

/** Cost of one compound: approve + claim + restake, at retail gas. */
const DEFAULT_GAS_COST_USD = 5;

/** Annualised volatility assumed for a mid-cap pair when none is given. */
const DEFAULT_ANNUAL_VOLATILITY = 0.5;

/** Divergence tolerated across a single compound before it is too much IL. */
const DEFAULT_MAX_IL_PER_COMPOUND_PERCENT = 1;

/** Compounding more often than this costs more gas than it can earn. */
const DEFAULT_MIN_COMPOUND_INTERVAL_HOURS = 6;

/** Upper bound on how long rewards are left unclaimed. */
const DEFAULT_MAX_COMPOUND_INTERVAL_HOURS = 720;

/** Interval used by the trigger when no plan has been computed. */
const DEFAULT_COMPOUND_INTERVAL_HOURS = 24;

/** Resolution of the interval search. */
const DEFAULT_COMPOUND_SEARCH_STEPS = 24;

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

@Injectable()
export class YieldOptimizationService {
  private logger = new Logger("YieldOptimizationService");

  constructor(
    @InjectRepository(DeFiYieldStrategy)
    private strategyRepository: Repository<DeFiYieldStrategy>,
    @InjectRepository(DeFiPosition)
    private positionRepository: Repository<DeFiPosition>,
    private protocolRegistry: ProtocolRegistry,
  ) {}

  /**
   * Impermanent loss of a 50/50 constant-product pool, as a signed fraction
   * (negative = a loss against simply holding both assets).
   *
   *   IL = 2 * sqrt(P) / (1 + P) - 1
   *
   * where P is the price ratio between the two pooled assets since the
   * position was opened. A head of -1 means the whole position is gone.
   *
   * Nominal APY hides this: a pool quoting 40% APY on a volatile pair can
   * still be a net loss once the LP is measured against holding the tokens.
   */
  calculateImpermanentLoss(priceRatio: number): number {
    if (!Number.isFinite(priceRatio) || priceRatio < 0) return 0;

    return (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
  }

  /**
   * Gas-versus-reward compounding plan.
   *
   * Compounding has two costs pulling in opposite directions. Gas is paid per
   * compound, so compounding more often costs more (drag ∝ 1/interval). The
   * exposure to divergence is paid per unit time while the position is in the
   * pool, so it accrues as the position is held (modelled here as a Brownian
   * price move: P = 1 + σ√(t/T), i.e. the same σ²·t/8 divergence a volatility
   * estimate implies).
   *
   * Each candidate interval is scored on its net APY — gross APY minus the
   * annualised impermanent loss minus the annualised gas bill — and the best
   * one that is actually worth executing wins. An interval is only worth
   * executing if the rewards it accrues at least cover the gas it costs
   * (the break-even interval) and the divergence it exposes the position to
   * stays inside the caller's risk limit.
   */
  calculateCompoundingPlan(inputs: CompoundingInputs): CompoundingPlan {
    const positionValueUsd = Math.max(
      0,
      inputs.positionValueUsd ?? DEFAULT_POSITION_VALUE_USD,
    );
    const grossApy = inputs.apy ?? 0;
    const gasCostUsd = Math.max(
      0,
      inputs.gasCostPerCompoundUsd ?? DEFAULT_GAS_COST_USD,
    );
    const volatility = Math.max(
      0,
      inputs.annualVolatility ?? DEFAULT_ANNUAL_VOLATILITY,
    );
    const minIntervalHours = Math.max(
      1,
      inputs.minIntervalHours ?? DEFAULT_MIN_COMPOUND_INTERVAL_HOURS,
    );
    const maxIntervalHours = Math.max(
      minIntervalHours,
      inputs.maxIntervalHours ?? DEFAULT_MAX_COMPOUND_INTERVAL_HOURS,
    );
    const ilLimitPercent =
      inputs.maxImpermanentLossPerCompoundPercent ??
      DEFAULT_MAX_IL_PER_COMPOUND_PERCENT;
    const steps = Math.max(2, inputs.steps ?? DEFAULT_COMPOUND_SEARCH_STEPS);

    // An observed price ratio is a measured fact about the position and
    // overrides the volatility model; it does not vary with the interval.
    const observedPriceRatio =
      inputs.priceRatio !== undefined && inputs.priceRatio > 0
        ? inputs.priceRatio
        : null;

    const hourlyRewardUsd =
      positionValueUsd * (grossApy / 100) / HOURS_PER_YEAR;
    const breakEvenIntervalHours =
      hourlyRewardUsd > 0 ? gasCostUsd / hourlyRewardUsd : Infinity;

    const candidates: CompoundingCandidate[] = [];

    for (let step = 0; step < steps; step++) {
      const intervalHours =
        minIntervalHours +
        (maxIntervalHours - minIntervalHours) * (step / (steps - 1));

      const compoundsPerYear = HOURS_PER_YEAR / intervalHours;
      const annualGasUsd = compoundsPerYear * gasCostUsd;
      const gasDragApy =
        positionValueUsd > 0 ? (annualGasUsd / positionValueUsd) * 100 : 0;

      const priceRatio =
        observedPriceRatio ??
        1 + volatility * Math.sqrt(intervalHours / HOURS_PER_YEAR);
      const impermanentLossPercent =
        this.calculateImpermanentLoss(priceRatio) * 100;
      const impermanentLossApy = compoundsPerYear * impermanentLossPercent;
      const rewardAccruedUsd = hourlyRewardUsd * intervalHours;

      candidates.push({
        intervalHours: round(intervalHours),
        compoundsPerYear: round(compoundsPerYear),
        rewardAccruedUsd: round(rewardAccruedUsd),
        annualGasUsd: round(annualGasUsd),
        gasDragApy: round(gasDragApy),
        impermanentLossPercentPerCompound: round(impermanentLossPercent, 6),
        impermanentLossApy: round(impermanentLossApy),
        netApy: round(grossApy + impermanentLossApy - gasDragApy),
      });
    }

    const worthExecuting = candidates.filter(
      (c) =>
        c.rewardAccruedUsd >= gasCostUsd &&
        Math.abs(c.impermanentLossPercentPerCompound) <= ilLimitPercent,
    );

    // When nothing clears the bar, still report the least-bad interval rather
    // than refusing to answer — the caller needs to see that it does not work.
    const pool = worthExecuting.length > 0 ? worthExecuting : candidates;
    const best = pool.reduce((a, b) => (b.netApy > a.netApy ? b : a));

    return {
      optimalIntervalHours: best.intervalHours,
      compoundsPerYear: best.compoundsPerYear,
      breakEvenIntervalHours: Number.isFinite(breakEvenIntervalHours)
        ? round(breakEvenIntervalHours)
        : null,
      grossApy,
      gasDragApy: best.gasDragApy,
      impermanentLossPercent: best.impermanentLossPercentPerCompound,
      impermanentLossApy: best.impermanentLossApy,
      netApy: best.netApy,
      profitable: best.netApy > 0,
      candidates: pool,
    };
  }

  /**
   * Should an automated run compound this strategy right now?
   *
   * Two conditions have to hold: enough time must have passed since the last
   * compound, and the rewards accrued in that time must exceed what the
   * compound costs in gas. Compounding below break-even burns the position.
   */
  evaluateCompoundingTrigger(
    input: CompoundingTriggerInput,
  ): CompoundingTriggerResult {
    const now = input.now ?? new Date();
    const positionValueUsd = Math.max(0, input.positionValueUsd ?? 0);
    const intervalHours = Math.max(
      1,
      input.recommendedIntervalHours ?? DEFAULT_COMPOUND_INTERVAL_HOURS,
    );
    const gasCostUsd = Math.max(
      0,
      input.gasCostPerCompoundUsd ?? DEFAULT_GAS_COST_USD,
    );
    const elapsedHours = input.lastCompoundedAt
      ? (now.getTime() - input.lastCompoundedAt.getTime()) / (60 * 60 * 1000)
      : Number.POSITIVE_INFINITY;
    const pendingRewardsUsd = Math.max(0, input.pendingRewardsUsd ?? 0);

    const intervalElapsed = elapsedHours >= intervalHours;
    const nextEligibleAt = input.lastCompoundedAt
      ? new Date(
          input.lastCompoundedAt.getTime() + intervalHours * 60 * 60 * 1000,
        )
      : null;

    const base = {
      elapsedHours: Number.isFinite(elapsedHours) ? round(elapsedHours) : null,
      intervalHours,
      pendingRewardsUsd: round(pendingRewardsUsd),
      gasCostUsd: round(gasCostUsd),
      nextEligibleAt,
    };

    if (positionValueUsd <= 0) {
      return { ...base, shouldCompound: false, reason: "no_position" };
    }

    if (!intervalElapsed) {
      return { ...base, shouldCompound: false, reason: "interval_not_elapsed" };
    }

    if (pendingRewardsUsd < gasCostUsd) {
      return { ...base, shouldCompound: false, reason: "rewards_below_gas" };
    }

    return { ...base, shouldCompound: true, reason: "ready" };
  }

  /**
   * Find highest yield opportunities across protocols
   */
  async findHighestYieldOpportunities(
    tokens: string[],
    chain: string = "ethereum",
    economics: YieldEconomics = {},
  ): Promise<Map<string, YieldOpportunity[]>> {
    const opportunities = new Map<string, YieldOpportunity[]>();

    for (const token of tokens) {
      const tokenOpportunities: YieldOpportunity[] = [];

      for (const adapter of this.protocolRegistry.getAllAdapters()) {
        if (!adapter.supportedChains.includes(chain)) continue;

        try {
          const apy = await adapter.getAPY(token);
          const metrics = await adapter.getProtocolMetrics();
          const riskScore = this.calculateProtocolRiskScore(metrics);
          const plan = this.calculateCompoundingPlan({ ...economics, apy });

          const opportunity: YieldOpportunity = {
            protocol: adapter.name,
            token,
            apy,
            tvl: metrics.tvl,
            riskScore,
            jpy: apy - riskScore * 0.1, // Risk-adjusted
            impermanentLossPercent: plan.impermanentLossPercent,
            impermanentLossApy: plan.impermanentLossApy,
            gasDragApy: plan.gasDragApy,
            netApy: plan.netApy,
            optimalCompoundingIntervalHours: plan.optimalIntervalHours,
          };

          tokenOpportunities.push(opportunity);
        } catch (error) {
          this.logger.warn(
            `Error fetching APY for ${adapter.name} ${token}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // Sort by risk-adjusted yield
      tokenOpportunities.sort((a, b) => b.jpy - a.jpy);
      opportunities.set(token, tokenOpportunities);
    }

    return opportunities;
  }

  /**
   * Optimize yield for a given capital allocation
   */
  async optimizeYieldAllocation(
    userId: string,
    totalCapital: number,
    strategyType: StrategyType,
    constraints: YieldConstraints,
  ): Promise<OptimizationResult> {
    const economics: YieldEconomics = {
      positionValueUsd: constraints.positionValueUsd,
      gasCostPerCompoundUsd: constraints.gasCostPerCompoundUsd,
      annualVolatility: constraints.annualVolatility,
      priceRatio: constraints.priceRatio,
      maxImpermanentLossPerCompoundPercent:
        constraints.maxImpermanentLossPerCompoundPercent,
      minIntervalHours: constraints.minIntervalHours,
      maxIntervalHours: constraints.maxIntervalHours,
    };

    const opportunities = await this.findHighestYieldOpportunities(
      constraints.preferredTokens || ["USDC", "DAI", "USDT"],
      constraints.chain ?? "ethereum",
      economics,
    );

    let allocations: AllocationResult[] = [];

    switch (strategyType) {
      case StrategyType.HIGHEST_YIELD:
        allocations = this.allocateForHighestYield(
          opportunities,
          totalCapital,
          constraints,
        );
        break;

      case StrategyType.STABLE_YIELD:
        allocations = this.allocateForStableYield(
          opportunities,
          totalCapital,
          constraints,
        );
        break;

      case StrategyType.RISK_ADJUSTED:
        allocations = this.allocateForRiskAdjusted(
          opportunities,
          totalCapital,
          constraints,
        );
        break;

      case StrategyType.DIVERSIFIED:
        allocations = this.allocateForDiversification(
          opportunities,
          totalCapital,
          constraints,
        );
        break;

      default:
        throw new Error(`Unknown strategy type: ${strategyType}`);
    }

    const expectedApy = this.calculateExpectedAPY(allocations);
    const expectedYield = totalCapital * (expectedApy / 100);
    const netApy = this.weightedAverage(allocations, "netApy", expectedApy);
    const impermanentLossPercent = this.weightedAverage(
      allocations,
      "impermanentLossPercent",
      0,
    );
    const impermanentLossApy = this.weightedAverage(
      allocations,
      "impermanentLossApy",
      0,
    );
    const gasDragApy = this.weightedAverage(allocations, "gasDragApy", 0);
    const representative = allocations[0];

    return {
      strategyType,
      totalCapital,
      expectedApy,
      expectedYield,
      // Nominal APY overstates a provider's return once divergence and gas
      // are taken out, so both views are reported.
      netApy,
      expectedNetYield: totalCapital * (netApy / 100),
      estimatedImpermanentLossPercent: impermanentLossPercent,
      impermanentLossApy,
      gasDragApy,
      recommendedCompoundingIntervalHours:
        representative?.optimalCompoundingIntervalHours ?? null,
      allocations,
      constraints,
    };
  }

  /**
   * Rebalance existing strategy based on new market conditions
   */
  async rebalanceStrategy(strategyId: string): Promise<RebalanceResult> {
    const strategy = await this.strategyRepository.findOne({
      where: { id: strategyId },
    });

    if (!strategy) throw new Error("Strategy not found");

    // Get current positions
    const positions = await this.positionRepository.find({
      where: {
        // Filter positions that belong to this strategy
        // This would need to be extended in the entity model
      },
    });

    // Analyze current allocation drift
    const currentAllocation = this.calculateCurrentAllocation(positions);
    const drift = this.calculateAllocationDrift(
      currentAllocation,
      strategy.allocation_weights,
    );

    // If drift exceeds threshold, rebalance
    if (drift > 0.05) {
      const opportunities = await this.findHighestYieldOpportunities(
        strategy.tokens,
      );

      const newAllocations = this.allocateForHighestYield(
        opportunities,
        strategy.current_value,
        {
          maxRiskScore: strategy.max_risk_score,
          excludeProtocols: strategy.constraints?.excludeProtocols,
          preferredTokens: strategy.tokens,
        },
      );

      return {
        strategyId,
        currentAllocation,
        targetAllocation: strategy.allocation_weights,
        drift,
        needsRebalance: true,
        suggestedAllocations: newAllocations,
      };
    }

    return {
      strategyId,
      currentAllocation,
      targetAllocation: strategy.allocation_weights,
      drift,
      needsRebalance: false,
    };
  }

  /**
   * Compounding plan for a stored strategy, built from its own value and APY.
   * Callers may override any economic input to model a different position.
   */
  async getCompoundingPlan(
    strategyId: string,
    overrides: Partial<CompoundingInputs> = {},
  ): Promise<CompoundingPlan> {
    const strategy = await this.strategyRepository.findOne({
      where: { id: strategyId },
    });

    if (!strategy) throw new Error("Strategy not found");

    // The two strategy-derived inputs are applied *after* the spread and only
    // when the caller actually supplied them. A key that is present but
    // `undefined` would otherwise overwrite the stored value/apy with nothing,
    // and a request that omits them would be priced at 0% APY.
    return this.calculateCompoundingPlan({
      ...overrides,
      apy: overrides.apy ?? (Number(strategy.current_apy) || 0),
      positionValueUsd:
        overrides.positionValueUsd ?? (Number(strategy.current_value) || 0),
    });
  }

  /**
   * Auto-compound rewards back into positions. This is the explicit,
   * user-initiated path: it always compounds. The interval-aware path is
   * {@link runScheduledCompounding}.
   */
  async autoCompoundRewards(strategyId: string): Promise<CompoundingResult> {
    const strategy = await this.strategyRepository.findOne({
      where: { id: strategyId },
    });

    if (!strategy) throw new Error("Strategy not found");

    // Get positions for this strategy
    const positions = await this.positionRepository.find({
      where: {
        // Filter positions for this strategy
      },
    });

    const { transactions, totalCompounded } =
      await this.collectClaimableRewards(positions);

    return this.applyCompounding(strategyId, strategy, transactions);
  }

  /**
   * Scheduled auto-compounding: only compounds when the interval has elapsed
   * *and* the rewards accrued since the last compound exceed the gas the
   * compound costs. Without the second condition an automated job drains a
   * small position into gas fees.
   */
  async runScheduledCompounding(
    strategyId: string,
    options: { force?: boolean; now?: Date } = {},
  ): Promise<CompoundingResult> {
    const strategy = await this.strategyRepository.findOne({
      where: { id: strategyId },
    });

    if (!strategy) throw new Error("Strategy not found");

    if (!strategy.auto_compound_enabled && !options.force) {
      return {
        strategyId,
        totalCompounded: 0,
        compoundingCount: 0,
        transactions: [],
        skipped: true,
        reason: "auto_compound_disabled",
      };
    }

    const positions = await this.positionRepository.find({
      where: {
        // Filter positions for this strategy
      },
    });

    const { transactions, totalCompounded } =
      await this.collectClaimableRewards(positions);

    const plan = this.calculateCompoundingPlan({
      positionValueUsd: Number(strategy.current_value) || 0,
      apy: Number(strategy.current_apy) || 0,
    });

    const trigger = this.evaluateCompoundingTrigger({
      lastCompoundedAt: strategy.last_compounded_at,
      apy: Number(strategy.current_apy) || 0,
      positionValueUsd: Number(strategy.current_value) || 0,
      recommendedIntervalHours: plan.optimalIntervalHours,
      pendingRewardsUsd: totalCompounded,
      now: options.now,
    });

    if (!trigger.shouldCompound) {
      return {
        strategyId,
        totalCompounded: 0,
        compoundingCount: 0,
        transactions: [],
        skipped: true,
        reason: trigger.reason,
        trigger,
      };
    }

    // Rewards are reused rather than fetched again: the trigger already
    // needed their value, and a second read would double the adapter calls.
    return {
      ...this.applyCompounding(
        strategyId,
        strategy,
        transactions,
        options.now,
      ),
      trigger,
    };
  }

  /** Book the compounded rewards onto the strategy. */
  private async applyCompounding(
    strategyId: string,
    strategy: DeFiYieldStrategy,
    transactions: CompoundingTransaction[],
    now: Date = new Date(),
  ): Promise<CompoundingResult> {
    const totalCompounded = transactions.reduce((sum, t) => sum + t.value, 0);

    strategy.accumulated_yield =
      (strategy.accumulated_yield || 0) + totalCompounded;
    strategy.last_compounded_at = now;
    await this.strategyRepository.save(strategy);

    return {
      strategyId,
      totalCompounded,
      compoundingCount: transactions.length,
      transactions,
      skipped: false,
    };
  }

  /**
   * Read the claimable rewards of every position through its protocol adapter.
   */
  private async collectClaimableRewards(positions: DeFiPosition[]): Promise<{
    transactions: CompoundingTransaction[];
    totalCompounded: number;
  }> {
    const transactions: CompoundingTransaction[] = [];
    let totalCompounded = 0;

    for (const position of positions) {
      try {
        const adapter = this.protocolRegistry.getAdapter(
          position.protocol as any,
        );
        const rewards = await adapter.getRewards(
          [position.contract_address],
          position.wallet_address,
        );

        for (const reward of rewards) {
          if (reward.claimable && reward.amount > 0) {
            totalCompounded += reward.valueUSD;

            transactions.push({
              protocol: position.protocol,
              token: reward.token,
              amount: reward.amount,
              value: reward.valueUSD,
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `Error compounding rewards for position ${position.id}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return { transactions, totalCompounded };
  }

  // Helper methods

  private calculateProtocolRiskScore(metrics: any): number {
    let score = 0;

    // TVL factor (higher TVL = lower risk)
    if (metrics.tvl < 10000000) score += 30;
    else if (metrics.tvl < 100000000) score += 20;
    else if (metrics.tvl < 1000000000) score += 10;

    // Age factor (newer = higher risk)
    if (metrics.launchDate) {
      const ageMonths =
        (Date.now() - new Date(metrics.launchDate).getTime()) /
        (1000 * 60 * 60 * 24 * 30);
      if (ageMonths < 6) score += 30;
      else if (ageMonths < 12) score += 20;
      else if (ageMonths < 24) score += 10;
    }

    // Audit status
    if (!metrics.audits || metrics.audits.length === 0) score += 20;
    else score -= Math.min(10, metrics.audits.length * 3);

    // Insurance coverage
    if (!metrics.insurance) score += 15;

    return Math.min(100, score);
  }

  private allocateForHighestYield(
    opportunities: Map<string, YieldOpportunity[]>,
    totalCapital: number,
    constraints: YieldConstraints,
  ): AllocationResult[] {
    const allocations: AllocationResult[] = [];

    for (const [token, opps] of opportunities) {
      if (opps.length === 0) continue;

      // Take highest yield opportunity
      const topOpp = opps[0];

      if (
        constraints.maxRiskScore &&
        topOpp.riskScore > constraints.maxRiskScore
      ) {
        // Take next best within risk tolerance
        const safer = opps.find((o) => o.riskScore <= constraints.maxRiskScore);
        if (safer)
          allocations.push(this.createAllocation(safer, totalCapital * 0.1)); //  Default 10% per token
      } else {
        allocations.push(this.createAllocation(topOpp, totalCapital * 0.1));
      }
    }

    return allocations;
  }

  private allocateForStableYield(
    opportunities: Map<string, YieldOpportunity[]>,
    totalCapital: number,
    constraints: YieldConstraints,
  ): AllocationResult[] {
    // Prefer lower-risk protocols
    const allocations: AllocationResult[] = [];

    for (const [token, opps] of opportunities) {
      const stableOpps = opps.filter((o) => o.riskScore < 40);
      if (stableOpps.length > 0) {
        allocations.push(
          this.createAllocation(stableOpps[0], totalCapital * 0.1),
        );
      }
    }

    return allocations;
  }

  private allocateForRiskAdjusted(
    opportunities: Map<string, YieldOpportunity[]>,
    totalCapital: number,
    constraints: YieldConstraints,
  ): AllocationResult[] {
    // Weight by Sharpe-like ratio (JPY = APY - risk adjustment)
    let totalJpy = 0;
    const candidates: { opp: YieldOpportunity; jpy: number }[] = [];

    for (const [token, opps] of opportunities) {
      for (const opp of opps) {
        if (
          constraints.maxRiskScore &&
          opp.riskScore > constraints.maxRiskScore
        )
          continue;
        candidates.push({ opp, jpy: opp.jpy });
        totalJpy += opp.jpy;
      }
    }

    // Allocate proportional to JPY
    return candidates.map((c) => ({
      ...this.allocationMetrics(c.opp),
      protocol: c.opp.protocol,
      token: c.opp.token,
      allocation: (c.jpy / totalJpy) * totalCapital,
      expectedApy: c.opp.apy,
    }));
  }

  private allocateForDiversification(
    opportunities: Map<string, YieldOpportunity[]>,
    totalCapital: number,
    constraints: YieldConstraints,
  ): AllocationResult[] {
    const allocations: AllocationResult[] = [];
    const tokenCount = opportunities.size;

    for (const [token, opps] of opportunities) {
      if (opps.length > 0) {
        const allocation = totalCapital / tokenCount;
        allocations.push(this.createAllocation(opps[0], allocation));
      }
    }

    return allocations;
  }

  private createAllocation(
    opportunity: YieldOpportunity,
    amount: number,
  ): AllocationResult {
    return {
      ...this.allocationMetrics(opportunity),
      protocol: opportunity.protocol,
      token: opportunity.token,
      allocation: amount,
      expectedApy: opportunity.apy,
    };
  }

  /** Net-yield metrics carried from an opportunity onto its allocation. */
  private allocationMetrics(
    opportunity: YieldOpportunity,
  ): Pick<
    AllocationResult,
    | "impermanentLossPercent"
    | "impermanentLossApy"
    | "gasDragApy"
    | "netApy"
    | "optimalCompoundingIntervalHours"
  > {
    return {
      impermanentLossPercent: opportunity.impermanentLossPercent ?? 0,
      impermanentLossApy: opportunity.impermanentLossApy ?? 0,
      gasDragApy: opportunity.gasDragApy ?? 0,
      netApy: opportunity.netApy ?? opportunity.apy,
      optimalCompoundingIntervalHours:
        opportunity.optimalCompoundingIntervalHours ?? null,
    };
  }

  private calculateExpectedAPY(allocations: AllocationResult[]): number {
    const totalAllocation = allocations.reduce(
      (sum, a) => sum + a.allocation,
      0,
    );
    const totalYield = allocations.reduce(
      (sum, a) => sum + (a.allocation * a.expectedApy) / 100,
      0,
    );
    return (totalYield / totalAllocation) * 100;
  }

  /** Allocation-weighted mean of one metric across the allocations. */
  private weightedAverage(
    allocations: AllocationResult[],
    metric:
      | "netApy"
      | "impermanentLossPercent"
      | "impermanentLossApy"
      | "gasDragApy",
    fallback: number,
  ): number {
    const totalAllocation = allocations.reduce(
      (sum, a) => sum + a.allocation,
      0,
    );
    if (totalAllocation <= 0) return fallback;

    const total = allocations.reduce(
      (sum, a) => sum + (a.allocation * a[metric]) / totalAllocation,
      0,
    );
    return round(total, 4);
  }

  private calculateCurrentAllocation(
    positions: DeFiPosition[],
  ): Record<string, number> {
    const allocation: Record<string, number> = {};

    for (const position of positions) {
      const key = `${position.protocol}:${position.token_symbol}`;
      allocation[key] = (allocation[key] || 0) + position.current_amount;
    }

    return allocation;
  }

  private calculateAllocationDrift(
    current: Record<string, number>,
    target: Record<string, number>,
  ): number {
    let totalDrift = 0;
    const allKeys = new Set([...Object.keys(current), ...Object.keys(target)]);

    for (const key of allKeys) {
      const currentVal = current[key] || 0;
      const targetVal = target[key] || 0;
      totalDrift += Math.abs(currentVal - targetVal);
    }

    return totalDrift / (Object.values(target).reduce((a, b) => a + b, 0) || 1);
  }
}

/** One claim of rewards back into a position. */
export interface CompoundingTransaction {
  protocol: string;
  token: string;
  amount: number;
  value: number;
}

export interface YieldOpportunity {
  protocol: string;
  token: string;
  apy: number;
  tvl: number;
  riskScore: number;
  jpy: number; // JPY = risk-adjusted yield
  /**
   * Impermanent loss for a single compound, negative
   * (e.g. -0.22 for -0.22%).
   */
  impermanentLossPercent: number;
  /** The same loss annualised over a year of compounding, negative. */
  impermanentLossApy: number;
  /** Annualised cost of gas, positive (e.g. 0.61 for 0.61%). */
  gasDragApy: number;
  /** APY after impermanent loss and gas. */
  netApy: number;
  optimalCompoundingIntervalHours: number;
}

/**
 * Economics inputs for the net-yield calculations. Every field has a default,
 * so callers that know nothing about gas or volatility still get a figure.
 */
export interface YieldEconomics {
  /** Size of the position the APY is applied to; drives the gas drag. */
  positionValueUsd?: number;
  /** Cost of one compound (approve + claim + restake) in USD. */
  gasCostPerCompoundUsd?: number;
  /** Annualised volatility of the pooled pair, as a decimal (0.5 = 50%). */
  annualVolatility?: number;
  /** Observed price ratio P of the pair; overrides the volatility model. */
  priceRatio?: number;
  /** Risk limit on the divergence accepted per single compound. */
  maxImpermanentLossPerCompoundPercent?: number;
  minIntervalHours?: number;
  maxIntervalHours?: number;
}

export interface YieldConstraints extends YieldEconomics {
  maxRiskScore?: number;
  minLiquidity?: number;
  preferredTokens?: string[];
  excludeProtocols?: string[];
  maxDrift?: number;
  chain?: string;
}

export interface AllocationResult {
  protocol: string;
  token: string;
  allocation: number;
  expectedApy: number;
  /** Impermanent loss for a single compound, negative. */
  impermanentLossPercent: number;
  /** The same loss annualised at the chosen interval, negative. */
  impermanentLossApy: number;
  gasDragApy: number;
  netApy: number;
  optimalCompoundingIntervalHours: number | null;
}

export interface OptimizationResult {
  strategyType: StrategyType;
  totalCapital: number;
  expectedApy: number;
  expectedYield: number;
  /** Nominal APY after impermanent loss and gas. */
  netApy: number;
  expectedNetYield: number;
  /** Allocation-weighted impermanent loss for a single compound, negative. */
  estimatedImpermanentLossPercent: number;
  /** The same loss annualised at the recommended interval, negative. */
  impermanentLossApy: number;
  gasDragApy: number;
  recommendedCompoundingIntervalHours: number | null;
  allocations: AllocationResult[];
  constraints: YieldConstraints;
}

export interface RebalanceResult {
  strategyId: string;
  currentAllocation: Record<string, number>;
  targetAllocation: Record<string, number>;
  drift: number;
  needsRebalance: boolean;
  suggestedAllocations?: AllocationResult[];
}

/** One scored compounding interval. */
export interface CompoundingCandidate {
  intervalHours: number;
  compoundsPerYear: number;
  rewardAccruedUsd: number;
  annualGasUsd: number;
  gasDragApy: number;
  impermanentLossPercentPerCompound: number;
  impermanentLossApy: number;
  netApy: number;
}

export interface CompoundingInputs extends YieldEconomics {
  /** Nominal APY of the position, as a percentage. */
  apy: number;
  /** Number of candidate intervals to score. */
  steps?: number;
}

export interface CompoundingPlan {
  optimalIntervalHours: number;
  compoundsPerYear: number;
  /** Shortest interval whose rewards cover the gas of compounding. */
  breakEvenIntervalHours: number | null;
  grossApy: number;
  gasDragApy: number;
  /** Impermanent loss for a single compound at the chosen interval. */
  impermanentLossPercent: number;
  /** The same loss annualised over a year of compounding. */
  impermanentLossApy: number;
  netApy: number;
  profitable: boolean;
  candidates: CompoundingCandidate[];
}

export interface CompoundingTriggerInput {
  lastCompoundedAt: Date | null;
  apy: number;
  positionValueUsd: number;
  /** Claimable rewards accrued so far, in USD. */
  pendingRewardsUsd?: number;
  gasCostPerCompoundUsd?: number;
  recommendedIntervalHours?: number;
  now?: Date;
}

export type CompoundingSkipReason =
  | "no_position"
  | "interval_not_elapsed"
  | "rewards_below_gas"
  | "ready";

export interface CompoundingTriggerResult {
  shouldCompound: boolean;
  reason: CompoundingSkipReason;
  elapsedHours: number | null;
  intervalHours: number;
  pendingRewardsUsd: number;
  gasCostUsd: number;
  nextEligibleAt: Date | null;
}

export interface CompoundingResult {
  strategyId: string;
  totalCompounded: number;
  compoundingCount: number;
  transactions: CompoundingTransaction[];
  /** True when an automated run declined to compound. */
  skipped?: boolean;
  reason?: CompoundingSkipReason | "auto_compound_disabled";
  trigger?: CompoundingTriggerResult;
}
