/**
 * AgentScoring — pure, dependency-free multi-factor agent performance scoring & ranking.
 *
 * Powers the agent-discovery marketplace recommendation engine (issue #56). Computes a single 0–100
 * score per agent from four normalized factors with configurable weights, and ranks agents into a
 * leaderboard. Pure static functions (no DB / Nest DI) so the math is unit-testable in isolation and
 * reusable by a scoring service, discovery endpoints, and the cached daily leaderboard job.
 *
 * Default weights (sum to 1): successRate 0.40, roi 0.30, risk 0.20, userRating 0.10.
 * Weights are overridable (e.g. from env vars) via `resolveWeights`.
 */

/** Raw, observed metrics for an agent. All optional/defensive — missing -> neutral/zero. */
export interface AgentMetrics {
  agentId: string;
  /** Successful executions / total executions, in [0,1]. */
  successRate?: number;
  /** Return on investment as a ratio (0.25 = +25%, -0.1 = -10%). Unbounded; squashed when scored. */
  roi?: number;
  /**
   * Risk metric in [0,1] where 0 = low risk, 1 = high risk (e.g. normalized volatility / drawdown).
   * Scored inverted: lower risk -> higher score.
   */
  risk?: number;
  /** Average user rating in [0,5]. */
  userRating?: number;
  /** Total executions — used only as a tie-breaker (more proven sample ranks higher). */
  executions?: number;
  /** Timestamp at which the rating/reputation was last refreshed. */
  ratingUpdatedAt?: Date;
}

export interface ScoringWeights {
  successRate: number;
  roi: number;
  risk: number;
  userRating: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  successRate: 0.4,
  roi: 0.3,
  risk: 0.2,
  userRating: 0.1,
};

export interface ScoreBreakdown {
  successRate: number; // each normalized component, 0..1
  roi: number;
  risk: number;
  userRating: number;
  ratingDecay: number;
}

export interface AgentScore {
  agentId: string;
  score: number; // 0..100
  breakdown: ScoreBreakdown;
  executions: number;
}

export interface RankedAgent extends AgentScore {
  rank: number; // 1-based
}

export class AgentScoring {
  static readonly DECAY_THRESHOLD_DAYS = 30;
  static readonly DECAY_LAMBDA = 0.05;

  static decayFactor(updatedAt?: Date, now = new Date()): number {
    if (!updatedAt) return 1;
    const days = (now.getTime() - updatedAt.getTime()) / 86_400_000;
    if (days <= this.DECAY_THRESHOLD_DAYS) return 1;
    return Math.exp(-this.DECAY_LAMBDA * (days - this.DECAY_THRESHOLD_DAYS));
  }
  private static clamp(n: number, lo: number, hi: number): number {
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  private static round(n: number, dp = 2): number {
    const f = Math.pow(10, dp);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  /**
   * Squash an unbounded ROI ratio into [0,1] with a logistic curve centered at 0 (0 ROI -> 0.5).
   * k controls steepness; at default k=3, +33% ROI ≈ 0.73, -33% ≈ 0.27.
   */
  static normalizeRoi(roi: number, k = 3): number {
    const r = Number.isFinite(roi) ? roi : 0;
    return 1 / (1 + Math.exp(-k * r));
  }

  /** Merge partial weight overrides onto defaults, then renormalize so they always sum to 1. */
  static resolveWeights(partial?: Partial<ScoringWeights>): ScoringWeights {
    const p = partial ?? {};
    // coalesce per-field so explicit `undefined` keys don't clobber the defaults
    const merged: ScoringWeights = {
      successRate: p.successRate ?? DEFAULT_WEIGHTS.successRate,
      roi: p.roi ?? DEFAULT_WEIGHTS.roi,
      risk: p.risk ?? DEFAULT_WEIGHTS.risk,
      userRating: p.userRating ?? DEFAULT_WEIGHTS.userRating,
    };
    const total =
      merged.successRate + merged.roi + merged.risk + merged.userRating;
    if (total <= 0) return { ...DEFAULT_WEIGHTS };
    // already normalized (within float tolerance) -> pass through unchanged (idempotent)
    if (Math.abs(total - 1) < 1e-9) return merged;
    return {
      successRate: merged.successRate / total,
      roi: merged.roi / total,
      risk: merged.risk / total,
      userRating: merged.userRating / total,
    };
  }

  /** Normalized 0..1 components for an agent's raw metrics. */
  static breakdown(m: AgentMetrics): ScoreBreakdown {
    return {
      successRate: this.clamp(m.successRate ?? 0, 0, 1),
      roi: this.normalizeRoi(m.roi ?? 0),
      // invert risk: low risk -> high contribution
      risk: 1 - this.clamp(m.risk ?? 0, 0, 1),
      userRating: this.clamp((m.userRating ?? 0) / 5, 0, 1) * this.decayFactor(m.ratingUpdatedAt),
      ratingDecay: this.decayFactor(m.ratingUpdatedAt),
    };
  }

  /** Weighted 0..100 score for a single agent. */
  static score(m: AgentMetrics, partial?: Partial<ScoringWeights>): AgentScore {
    const w = this.resolveWeights(partial);
    const b = this.breakdown(m);
    const weighted =
      b.successRate * w.successRate +
      b.roi * w.roi +
      b.risk * w.risk +
      b.userRating * w.userRating;
    return {
      agentId: m.agentId,
      score: this.round(weighted * 100),
      breakdown: b,
      executions: m.executions ?? 0,
    };
  }

  /**
   * Rank agents into a leaderboard, highest score first. Ties broken by execution count (more proven
   * sample wins), then agentId for stable ordering.
   */
  static rank(
    agents: AgentMetrics[],
    partial?: Partial<ScoringWeights>,
  ): RankedAgent[] {
    const scored = (agents ?? []).map((a) => this.score(a, partial));
    scored.sort(
      (x, y) =>
        y.score - x.score ||
        y.executions - x.executions ||
        x.agentId.localeCompare(y.agentId),
    );
    return scored.map((s, i) => ({ ...s, rank: i + 1 }));
  }

  /** Top-N leaderboard. */
  static leaderboard(
    agents: AgentMetrics[],
    topN = 10,
    partial?: Partial<ScoringWeights>,
  ): RankedAgent[] {
    return this.rank(agents, partial).slice(0, Math.max(0, topN));
  }

  /** Filter agents whose score meets a minimum threshold (discovery endpoint support). */
  static filterByMinScore(
    agents: AgentMetrics[],
    minScore: number,
    partial?: Partial<ScoringWeights>,
  ): RankedAgent[] {
    return this.rank(agents, partial).filter((a) => a.score >= minScore);
  }

  /**
   * Read weights from a flat env-like map, e.g.
   *   AGENT_SCORE_WEIGHT_SUCCESS, _ROI, _RISK, _RATING
   * Missing/invalid keys fall back to defaults; result is renormalized to sum to 1.
   */
  static weightsFromEnv(
    env: Record<string, string | undefined>,
  ): ScoringWeights {
    const num = (v?: string) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return this.resolveWeights({
      successRate: num(env.AGENT_SCORE_WEIGHT_SUCCESS),
      roi: num(env.AGENT_SCORE_WEIGHT_ROI),
      risk: num(env.AGENT_SCORE_WEIGHT_RISK),
      userRating: num(env.AGENT_SCORE_WEIGHT_RATING),
    });
  }
}
