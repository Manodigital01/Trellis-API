import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Portfolio } from "../entities/portfolio.entity";
import {
  PortfolioAsset,
  Chain,
  AssetType,
} from "../entities/portfolio-asset.entity";
import {
  OptimizationHistory,
  OptimizationMethod,
  OptimizationStatus,
} from "../entities/optimization-history.entity";
import { RiskProfile } from "../entities/risk-profile.entity";
import { CreatePortfolioDto, UpdatePortfolioDto } from "../dto/portfolio.dto";
import { CreateOptimizationDto } from "../dto/optimization.dto";
import { AddHoldingDto, UpdateHoldingDto } from "../dto/portfolio-asset.dto";
import { PortfolioStatus } from "../entities/portfolio.entity";
import { ModernPortfolioTheory } from "../algorithms/modern-portfolio-theory";
import { BlackLittermanModel } from "../algorithms/black-litterman";
import { ConstraintOptimizer } from "../algorithms/constraint-optimizer";
import { PerformanceAnalyticsService } from "./performance-analytics.service";
import { PortfolioConstraintService } from "./portfolio-constraint.service";
import { AuditLogService } from "src/infrastructure/audit/audit-log.service";
import { SensitiveActionAuditService } from "src/infrastructure/audit/sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "src/infrastructure/audit/sensitive-actions/sensitive-action.enum";
import {
  PortfolioLifecycleState,
  PortfolioStateMachine,
  derivePortfolioLifecycleState,
} from "src/common/lifecycle/record-state-machines";
import { InvalidStateTransitionException } from "src/common/lifecycle/invalid-state-transition.exception";

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    @InjectRepository(Portfolio)
    private portfolioRepository: Repository<Portfolio>,
    @InjectRepository(PortfolioAsset)
    private portfolioAssetRepository: Repository<PortfolioAsset>,
    @InjectRepository(OptimizationHistory)
    private optimizationRepository: Repository<OptimizationHistory>,
    @InjectRepository(RiskProfile)
    private riskProfileRepository: Repository<RiskProfile>,
    private performanceService: PerformanceAnalyticsService,
    private portfolioConstraintService: PortfolioConstraintService,
    private auditLogService: AuditLogService,
    private sensitiveActionAudit: SensitiveActionAuditService,
  ) {}

  private validatePortfolioName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new BadRequestException("Portfolio name cannot be empty");
    }
  }

  private validateAllocation(allocation?: Record<string, number>): void {
    if (!allocation) return;
    const sum = Object.values(allocation).reduce(
      (acc, val) => acc + (val || 0),
      0,
    );
    if (Math.abs(sum - 100) > 0.1) {
      throw new BadRequestException(
        `Allocation percentages must sum to 100, got ${sum}`,
      );
    }
  }

  async deletePortfolio(portfolioId: string): Promise<void> {
    const portfolio = await this.getPortfolio(portfolioId);
    await this.portfolioRepository.remove(portfolio);
    await this.recordPortfolioChange(
      portfolio.userId,
      "portfolio",
      portfolioId,
      this.portfolioSnapshot(portfolio),
      { deleted: true },
      "Portfolio deleted by its owner",
    );
  }

  async archivePortfolio(
    portfolioId: string,
    status: PortfolioStatus = PortfolioStatus.ARCHIVED,
    auditContext?: { actorId?: string; actorRole?: string; reason?: string },
  ): Promise<Portfolio> {
    const portfolio = await this.getPortfolio(portfolioId);
    const currentLifecycle = derivePortfolioLifecycleState(portfolio);
    await PortfolioStateMachine.assertCanTransition(
      currentLifecycle,
      PortfolioLifecycleState.ARCHIVED,
      auditContext,
      { resourceId: portfolioId, resourceType: "portfolio" },
    );

    const before = this.portfolioSnapshot(portfolio);
    portfolio.status = PortfolioStatus.ARCHIVED;
    portfolio.deletedAt = new Date();
    const saved = await this.portfolioRepository.save(portfolio);
    await this.recordPortfolioChange(
      auditContext?.actorId ?? saved.userId,
      "portfolio",
      saved.id,
      before,
      this.portfolioSnapshot(saved),
      auditContext?.reason || "Portfolio archived",
    );
    return saved;
  }

  async transitionPortfolioState(
    portfolioId: string,
    targetState: PortfolioLifecycleState | string,
    auditContext?: { actorId?: string; actorRole?: string; reason?: string },
  ): Promise<{
    portfolio: Portfolio;
    lifecycleState: PortfolioLifecycleState;
    isTerminal: boolean;
    allowedTransitions: string[];
  }> {
    const portfolio = await this.getPortfolio(portfolioId);
    const currentLifecycle = derivePortfolioLifecycleState(portfolio);
    const target = targetState as PortfolioLifecycleState;

    await PortfolioStateMachine.assertCanTransition(
      currentLifecycle,
      target,
      auditContext,
      { resourceId: portfolioId, resourceType: "portfolio" },
    );

    const before = this.portfolioSnapshot(portfolio);
    portfolio.status = target as unknown as PortfolioStatus;
    if (target === PortfolioLifecycleState.ARCHIVED) {
      portfolio.deletedAt = new Date();
    } else {
      portfolio.deletedAt = null;
    }

    const saved = await this.portfolioRepository.save(portfolio);
    await this.recordPortfolioChange(
      auditContext?.actorId ?? saved.userId,
      "portfolio",
      saved.id,
      before,
      this.portfolioSnapshot(saved),
      auditContext?.reason || `Portfolio lifecycle transition: ${currentLifecycle} -> ${target}`,
    );

    const model = PortfolioStateMachine.deriveStateModel(target);
    return {
      portfolio: saved,
      lifecycleState: target,
      isTerminal: model.isTerminal,
      allowedTransitions: model.allowedTransitions,
    };
  }

  async setTargetAllocation(
    portfolioId: string,
    allocations: { [ticker: string]: number },
  ): Promise<Portfolio> {
    const portfolio = await this.getPortfolio(portfolioId);
    const before = this.portfolioSnapshot(portfolio);
    portfolio.targetAllocation = allocations;
    const saved = await this.portfolioRepository.save(portfolio);
    await this.recordPortfolioChange(
      saved.userId,
      "portfolio",
      saved.id,
      before,
      this.portfolioSnapshot(saved),
      "Portfolio target allocation changed",
    );
    return saved;
  }

  async createPortfolio(
    userId: string,
    dto: CreatePortfolioDto,
  ): Promise<Portfolio> {
    this.validatePortfolioName(dto.name);

    const existingPortfolio = await this.portfolioRepository.findOne({
      where: { name: dto.name, userId },
    });

    if (existingPortfolio && !existingPortfolio.deletedAt) {
      throw new BadRequestException("Portfolio with this name already exists");
    }

    const portfolio = this.portfolioRepository.create({
      ...dto,
      userId,
      status: PortfolioStatus.ACTIVE,
      currentAllocation: {},
      targetAllocation: {},
      totalValue: dto.totalValue || 0,
      autoRebalanceEnabled: dto.autoRebalanceEnabled || false,
      rebalanceThreshold: dto.rebalanceThreshold || 5,
    });

    const saved = await this.portfolioRepository.save(portfolio);
    await this.recordPortfolioChange(
      saved.userId,
      "portfolio",
      saved.id,
      { created: false },
      this.portfolioSnapshot(saved),
      "Portfolio created",
    );
    return saved;
  }

  async getPortfolio(portfolioId: string): Promise<Portfolio> {
    const portfolio = await this.portfolioRepository.findOne({
      where: { id: portfolioId },
      relations: ["assets", "optimizationHistory", "performanceMetrics"],
    });

    if (!portfolio || portfolio.deletedAt) {
      throw new NotFoundException("Portfolio not found");
    }

    return portfolio;
  }

  async getUserPortfolios(userId: string): Promise<Portfolio[]> {
    return this.portfolioRepository.find({
      where: { userId },
      relations: ["assets", "performanceMetrics"],
      order: { createdAt: "DESC" },
    });
  }

  async updatePortfolio(
    portfolioId: string,
    dto: UpdatePortfolioDto,
  ): Promise<Portfolio> {
    const portfolio = await this.getPortfolio(portfolioId);
    const before = this.portfolioSnapshot(portfolio);

    if (dto.name && dto.name !== portfolio.name) {
      this.validatePortfolioName(dto.name);
    }

    if (dto.status && dto.status !== portfolio.status) {
      const currentLifecycle = derivePortfolioLifecycleState(portfolio);
      const targetLifecycle = dto.status as unknown as PortfolioLifecycleState;
      await PortfolioStateMachine.assertCanTransition(
        currentLifecycle,
        targetLifecycle,
        undefined,
        { resourceId: portfolioId, resourceType: "portfolio" },
      );

      portfolio.status = dto.status;
      if (dto.status === PortfolioStatus.ARCHIVED) {
        portfolio.deletedAt = new Date();
      } else if (dto.status === PortfolioStatus.ACTIVE) {
        portfolio.deletedAt = null;
      }
    }

    Object.assign(portfolio, dto);

    const saved = await this.portfolioRepository.save(portfolio);
    await this.recordPortfolioChange(
      saved.userId,
      "portfolio",
      saved.id,
      before,
      this.portfolioSnapshot(saved),
      "Portfolio details changed",
    );
    return saved;
  }

  /**
   * Add holding to portfolio
   */
  async addHolding(
    portfolioId: string,
    dto: AddHoldingDto,
  ): Promise<PortfolioAsset> {
    const portfolio = await this.getPortfolio(portfolioId);

    if (dto.quantity <= 0) {
      throw new BadRequestException("Quantity must be positive");
    }

    if (dto.currentPrice !== undefined && dto.currentPrice < 0) {
      throw new BadRequestException("Current price cannot be negative");
    }

    const existingAsset = await this.portfolioAssetRepository.findOne({
      where: { portfolioId, ticker: dto.ticker },
    });

    if (existingAsset) {
      throw new BadRequestException(
        "Holding with same ticker and chain already exists",
      );
    }

    const asset = this.portfolioAssetRepository.create({
      ...dto,
      portfolioId,
      value: dto.quantity * (dto.currentPrice || 0),
    });

    await this.validatePortfolioConstraints(
      portfolio,
      [...(portfolio.assets || []), asset],
      dto,
      "ADD_HOLDING",
    );

    const saved = await this.portfolioAssetRepository.save(asset);

    await this.recordPortfolioChange(
      portfolio.userId,
      "portfolio_holding",
      saved.id,
      { created: false, portfolioId },
      this.holdingSnapshot(saved),
      "Holding added to portfolio",
    );

    await this.updatePortfolioMetrics(portfolioId);

    return saved;
  }

  /**
   * Update holding
   */
  async updateHolding(
    portfolioId: string,
    holdingId: string,
    dto: UpdateHoldingDto,
  ): Promise<PortfolioAsset> {
    const portfolio = await this.getPortfolio(portfolioId);

    const holding = await this.portfolioAssetRepository.findOne({
      where: { id: holdingId, portfolioId },
    });

    if (!holding) {
      throw new BadRequestException("Holding not found");
    }
    const before = this.holdingSnapshot(holding);

    // Update fields
    if (dto.quantity !== undefined) {
      holding.quantity = dto.quantity;
    }
    if (dto.currentPrice !== undefined) {
      holding.currentPrice = dto.currentPrice;
    }
    if (dto.costBasis !== undefined) {
      holding.costBasis = dto.costBasis;
      holding.costBasisPerShare =
        holding.quantity > 0 ? dto.costBasis / holding.quantity : 0;
    }

    // Recalculate value
    holding.value = holding.quantity * (holding.currentPrice || 0);

    // Recalculate unrealized gain
    if (holding.currentPrice && holding.costBasisPerShare) {
      holding.unrealizedGain =
        (holding.currentPrice - holding.costBasisPerShare) * holding.quantity;
    }

    const candidateAssets = (portfolio.assets || []).map((asset) =>
      asset.id === holding.id ? Object.assign(asset, holding) : asset,
    );

    await this.validatePortfolioConstraints(
      portfolio,
      candidateAssets,
      dto,
      "UPDATE_HOLDING",
    );

    const updated = await this.portfolioAssetRepository.save(holding);

    await this.recordPortfolioChange(
      portfolio.userId,
      "portfolio_holding",
      updated.id,
      before,
      this.holdingSnapshot(updated),
      "Portfolio holding value or quantity changed",
    );

    // Update portfolio metrics
    await this.updatePortfolioMetrics(portfolioId);

    return updated;
  }

  /**
   * Remove holding from portfolio
   */
  async removeHolding(portfolioId: string, holdingId: string): Promise<void> {
    const portfolio = await this.getPortfolio(portfolioId);
    const holding = await this.portfolioAssetRepository.findOne({
      where: { id: holdingId, portfolioId },
    });

    if (!holding) {
      throw new BadRequestException("Holding not found");
    }
    const before = this.holdingSnapshot(holding);

    await this.portfolioAssetRepository.remove(holding);
    await this.recordPortfolioChange(
      portfolio.userId,
      "portfolio_holding",
      holdingId,
      before,
      { deleted: true, portfolioId },
      "Holding removed from portfolio",
    );

    // Update portfolio metrics
    await this.updatePortfolioMetrics(portfolioId);
  }

  /**
   * Add asset to portfolio (keeping for backward compatibility)
   */
  async addAsset(
    portfolioId: string,
    ticker: string,
    name: string,
    quantity: number,
    currentPrice: number = 0,
    costBasis: number = 0,
  ): Promise<PortfolioAsset> {
    return this.addHolding(portfolioId, {
      ticker,
      name,
      chain: Chain.OTHER,
      quantity,
      currentPrice,
      costBasis,
    });
  }

  async updateAssetPrice(
    assetId: string,
    currentPrice: number,
  ): Promise<PortfolioAsset> {
    const asset = await this.portfolioAssetRepository.findOne({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundException("Asset not found");
    }
    const portfolio = await this.getPortfolio(asset.portfolioId);
    const before = this.holdingSnapshot(asset);

    if (currentPrice < 0) {
      throw new BadRequestException("Price cannot be negative");
    }

    asset.currentPrice = currentPrice;
    asset.value = asset.quantity * currentPrice;
    asset.lastPriceUpdate = new Date();

    // Recalculate unrealized gain
    if (asset.costBasisPerShare) {
      asset.unrealizedGain =
        (asset.currentPrice - asset.costBasisPerShare) * asset.quantity;
    }

    const updated = await this.portfolioAssetRepository.save(asset);
    await this.recordPortfolioChange(
      portfolio.userId,
      "portfolio_holding",
      updated.id,
      before,
      this.holdingSnapshot(updated),
      "Holding market price changed",
    );

    // Update portfolio metrics
    await this.updatePortfolioMetrics(asset.portfolioId);

    return updated;
  }

  /**
   * Update portfolio metrics
   */
  async updatePortfolioMetrics(portfolioId: string): Promise<void> {
    const portfolio = await this.getPortfolio(portfolioId);
    const before = this.portfolioSnapshot(portfolio);
    const assets = await this.portfolioAssetRepository.find({
      where: { portfolioId },
    });

    let totalValue = 0;
    for (const asset of assets) {
      totalValue += Number(asset.value || 0);
    }

    portfolio.totalValue = totalValue;

    const allocation: Record<string, number> = {};

    for (const asset of assets) {
      const percentage =
        totalValue > 0 ? (Number(asset.value) / totalValue) * 100 : 0;
      asset.allocationPercentage = percentage;
      allocation[`${asset.ticker}-${asset.chain}`] = percentage;
    }

    portfolio.currentAllocation = allocation;

    await this.portfolioRepository.save(portfolio);
    await this.portfolioAssetRepository.save(assets);
    await this.recordPortfolioChange(
      portfolio.userId,
      "portfolio",
      portfolio.id,
      before,
      this.portfolioSnapshot(portfolio),
      "Portfolio market value and allocation updated",
    );

    // Keep performance history current whenever value/allocation changes.
    try {
      await this.performanceService.recordSnapshot(
        portfolioId,
        totalValue,
        allocation,
      );
    } catch (error) {
      // Recording a snapshot must never block a portfolio update.
      this.logger.warn(
        `Failed to record performance snapshot for ${portfolioId}: ${error.message}`,
      );
    }
  }

  /**
   * Update portfolio allocation percentages (keeping for backward compatibility)
   */
  async updatePortfolioAllocation(portfolioId: string): Promise<void> {
    await this.updatePortfolioMetrics(portfolioId);
  }

  private async validatePortfolioConstraints(
    portfolio: Portfolio,
    assets: PortfolioAsset[],
    override: any,
    operation: string,
  ): Promise<void> {
    const evaluation = this.portfolioConstraintService.evaluatePortfolio(
      portfolio,
      assets,
    );

    const overrideAccepted = Boolean(override?.overrideConstraints);

    await this.auditLogService.recordVerification({
      portfolioId: portfolio.id,
      operation,
      valid: evaluation.valid,
      riskScore: evaluation.riskScore,
      violations: evaluation.violations,
      warnings: evaluation.warnings,
      overrideAccepted,
      overrideReason: override?.overrideReason,
      acknowledgedBy: override?.acknowledgedBy,
      timestamp: new Date().toISOString(),
    });

    if (!evaluation.valid && !overrideAccepted) {
      throw new BadRequestException(
        evaluation.violations.map((v) => v.message).join(" "),
      );
    }
  }

  private portfolioSnapshot(portfolio: Portfolio): Record<string, unknown> {
    return {
      id: portfolio.id,
      userId: portfolio.userId,
      name: portfolio.name,
      status: portfolio.status,
      totalValue: portfolio.totalValue,
      currentAllocation: portfolio.currentAllocation,
      targetAllocation: portfolio.targetAllocation,
      autoRebalanceEnabled: portfolio.autoRebalanceEnabled,
      rebalanceFrequency: portfolio.rebalanceFrequency,
      rebalanceThreshold: portfolio.rebalanceThreshold,
    };
  }

  private holdingSnapshot(holding: PortfolioAsset): Record<string, unknown> {
    return {
      id: holding.id,
      portfolioId: holding.portfolioId,
      ticker: holding.ticker,
      name: holding.name,
      chain: holding.chain,
      assetType: holding.type,
      quantity: holding.quantity,
      currentPrice: holding.currentPrice,
      value: holding.value,
      costBasis: holding.costBasis,
      unrealizedGain: holding.unrealizedGain,
    };
  }

  private recordPortfolioChange(
    actorId: string,
    resourceType: string,
    resourceId: string,
    beforeState: Record<string, unknown>,
    afterState: Record<string, unknown>,
    reason: string,
  ): Promise<unknown> {
    return this.sensitiveActionAudit.recordSensitiveAction({
      action: SensitiveAction.PORTFOLIO_RECORD_CHANGED,
      actorId,
      resourceType,
      resourceId,
      beforeState,
      afterState,
      reason,
    });
  }

  async runOptimization(
    portfolioId: string,
    dto: CreateOptimizationDto,
  ): Promise<OptimizationHistory> {
    const portfolio = await this.getPortfolio(portfolioId);
    const assets = await this.portfolioAssetRepository.find({
      where: { portfolioId },
    });

    if (assets.length === 0) {
      throw new BadRequestException("Portfolio has no assets to optimize");
    }

    const optimization = this.optimizationRepository.create({
      portfolioId,
      method: dto.method,
      status: OptimizationStatus.IN_PROGRESS,
      parameters: dto.parameters || {},
      suggestedAllocation: {},
      currentAllocation: portfolio.currentAllocation,
    });

    let result = await this.optimizationRepository.save(optimization);

    try {
      const expectedReturns = assets.map((a) => a.expectedReturn || 0.07);
      const volatilities = assets.map((a) => a.volatility || 0.15);

      const correlationMatrix = this.generateCorrelationMatrix(assets.length);

      const covarianceMatrix = ModernPortfolioTheory.calculateCovarianceMatrix(
        volatilities,
        correlationMatrix,
      );

      let suggestedWeights: number[] = [];

      switch (dto.method) {
        case OptimizationMethod.MEAN_VARIANCE:
          suggestedWeights = ModernPortfolioTheory.meanVarianceOptimization(
            expectedReturns,
            covarianceMatrix,
          );
          break;

        case OptimizationMethod.MIN_VARIANCE:
          suggestedWeights =
            ModernPortfolioTheory.minVarianceOptimization(covarianceMatrix);
          break;

        case OptimizationMethod.RISK_PARITY:
          suggestedWeights =
            ModernPortfolioTheory.riskParityOptimization(covarianceMatrix);
          break;

        case OptimizationMethod.MAX_SHARPE:
          suggestedWeights = ModernPortfolioTheory.meanVarianceOptimization(
            expectedReturns,
            covarianceMatrix,
            {},
            0.02,
          );
          break;

        default:
          suggestedWeights = new Array(assets.length).fill(1 / assets.length);
      }

      const suggestedAllocation: Record<string, number> = {};
      for (let i = 0; i < assets.length; i++) {
        suggestedAllocation[assets[i].ticker] = suggestedWeights[i] * 100;
        assets[i].suggestedAllocation = suggestedWeights[i] * 100;
      }

      const metrics = ModernPortfolioTheory.calculatePortfolioMetrics(
        suggestedWeights,
        expectedReturns,
        covarianceMatrix,
      );

      const currentReturn = 0;
      const currentVolatility = 0;

      const currentWeights = assets.map(
        (a) => (a.allocationPercentage || 0) / 100,
      );

      const currentMetrics = ModernPortfolioTheory.calculatePortfolioMetrics(
        currentWeights,
        expectedReturns,
        covarianceMatrix,
      );

      const improvementScore =
        currentMetrics.volatility > 0
          ? ((currentMetrics.volatility - metrics.volatility) /
              currentMetrics.volatility) *
            100
          : 0;

      result.status = OptimizationStatus.COMPLETED;
      result.suggestedAllocation = suggestedAllocation;
      result.expectedReturn = metrics.expectedReturn;
      result.expectedVolatility = metrics.volatility;
      result.expectedSharpeRatio = metrics.sharpeRatio;
      result.improvementScore = improvementScore;
      result.completedAt = new Date();

      result = await this.optimizationRepository.save(result);

      await this.portfolioAssetRepository.save(assets);

      this.logger.log(`Optimization completed for portfolio ${portfolioId}`);

      return result;
    } catch (error) {
      const err = error as any;
      this.logger.error(
        `Optimization failed: ${err?.message ?? String(error)}`,
      );

      result.status = OptimizationStatus.FAILED;
      result.errorMessage = error.message;
      await this.optimizationRepository.save(result);
      throw error;
    }
  }

  private generateCorrelationMatrix(size: number): number[][] {
    const matrix: number[][] = [];

    for (let i = 0; i < size; i++) {
      matrix[i] = [];
      for (let j = 0; j < size; j++) {
        if (i === j) {
          matrix[i][j] = 1;
        } else {
          matrix[i][j] = 0.5 + Math.random() * 0.2;
        }
      }
    }

    return matrix;
  }

  async approveOptimization(
    optimizationId: string,
    notes?: string,
  ): Promise<OptimizationHistory> {
    const optimization = await this.optimizationRepository.findOne({
      where: { id: optimizationId },
    });

    if (!optimization) {
      throw new NotFoundException("Optimization not found");
    }

    if (optimization.status !== OptimizationStatus.COMPLETED) {
      throw new BadRequestException(
        "Only completed optimizations can be approved",
      );
    }

    optimization.status = OptimizationStatus.APPROVED;
    if (notes) optimization.notes = notes;

    return this.optimizationRepository.save(optimization);
  }

  async implementOptimization(optimizationId: string): Promise<Portfolio> {
    const optimization = await this.optimizationRepository.findOne({
      where: { id: optimizationId },
    });

    if (!optimization) {
      throw new NotFoundException("Optimization not found");
    }

    if (optimization.status !== OptimizationStatus.APPROVED) {
      throw new BadRequestException(
        "Only approved optimizations can be implemented",
      );
    }

    const portfolio = await this.getPortfolio(optimization.portfolioId);

    portfolio.targetAllocation = optimization.suggestedAllocation;
    portfolio.lastRebalanceDate = new Date();

    optimization.status = OptimizationStatus.IMPLEMENTED;
    optimization.implementedAt = new Date();

    await this.optimizationRepository.save(optimization);

    return this.portfolioRepository.save(portfolio);
  }

  async getOptimizationHistory(
    portfolioId: string,
    limit: number = 10,
  ): Promise<OptimizationHistory[]> {
    return this.optimizationRepository.find({
      where: { portfolioId },
      order: { createdAt: "DESC" },
      take: limit,
    });
  }
}
