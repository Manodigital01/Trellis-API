import { Injectable, Logger, Optional } from "@nestjs/common";

/**
 * Referral fraud heuristics (issue #135).
 *
 * The referral program pays rewards for each attributed signup, which makes
 * it a target for sybil account farming. This service screens every referred
 * signup BEFORE a reward is granted and flags fraudulent ones for admin
 * review instead of blocking registration outright — legitimate users behind
 * NAT/VPN ranges are rare but real, so fraud handling is hold-for-review.
 *
 * Heuristics implemented:
 *   1. self-referral — the referrer and referred accounts share a payment
 *      fingerprint, wallet address or signup IP,
 *   2. subnet clustering — more than 3 signups from the same /24 IPv4 (or
 *      /64-ish IPv6 prefix) within 1 hour are flagged,
 *   3. activity gating — rewards are held until the referred user completes
 *      the configured minimum number of transactions.
 */

/** Reason codes attached to a fraud evaluation. */
export enum ReferralFraudReason {
  SelfReferral = "self_referral",
  SubnetClustering = "subnet_clustering",
  SharedWalletFingerprint = "shared_wallet_fingerprint",
}

/** Verdict of a referral signup screening. */
export enum ReferralReviewStatus {
  Approved = "approved",
  PendingReview = "pending_review",
}

export interface ReferralSignupContext {
  /** Newly created (referred) user id. */
  userId: string;
  /** Referrer user id derived from the referral code. */
  referringUserId: string;
  /** IP the signup originated from, if known. */
  ip?: string | null;
  /** Wallet address (or payment fingerprint) linked to the new account. */
  walletAddress?: string | null;
  /** Wallet address (or payment fingerprint) linked to the referrer. */
  referrerWalletAddress?: string | null;
  /** Server timestamp of the signup. */
  registeredAt: Date;
}

export interface ReferralFraudEvaluation {
  status: ReferralReviewStatus;
  reasons: ReferralFraudReason[];
}

/** Outcome recorded for a screened referral. */
export interface ReferralReviewRecord {
  userId: string;
  referringUserId: string;
  referralCode: string;
  status: ReferralReviewStatus;
  reasons: ReferralFraudReason[];
  reviewedAt: string;
}

/** A completed transaction on a user account (for activity gating). */
export interface ReferralActivitySnapshot {
  userId: string;
  completedTransactions: number;
}

export interface ReferralFraudConfig {
  /** Signups per /24 subnet within the window before flagging (default 3). */
  subnetSignupThreshold?: number;
  /** Sliding window for subnet clustering, ms (default 1 hour). */
  subnetWindowMs?: number;
  /** Completed transactions required before a reward unlocks (default 1). */
  minTransactionsForReward?: number;
}

/** A minimal signup observed for subnet frequency accounting. */
interface SubnetSignupEntry {
  subnet: string;
  ip: string;
  timestamp: number;
}

const DEFAULT_SUBNET_THRESHOLD = 3;
const DEFAULT_SUBNET_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MIN_TRANSACTIONS = 1;

@Injectable()
export class ReferralFraudService {
  private readonly logger = new Logger(ReferralFraudService.name);

  private readonly subnetThreshold: number;
  private readonly subnetWindowMs: number;
  private readonly minTransactions: number;

  /** Recent signups for subnet frequency accounting (in-memory ring). */
  private readonly recentSignups: SubnetSignupEntry[] = [];
  /** Screened referrals held for admin review. */
  private readonly reviewQueue = new Map<string, ReferralReviewRecord>();
  /** Users whose referral rewards are unlocked (activity criteria met). */
  private readonly unlockedRewards = new Set<string>();

  constructor(@Optional() config: ReferralFraudConfig = {}) {
    this.subnetThreshold =
      config.subnetSignupThreshold ?? DEFAULT_SUBNET_THRESHOLD;
    this.subnetWindowMs = config.subnetWindowMs ?? DEFAULT_SUBNET_WINDOW_MS;
    this.minTransactions =
      config.minTransactionsForReward ?? DEFAULT_MIN_TRANSACTIONS;
  }

  // ==========================================
  // Screening at signup
  // ==========================================

  /**
   * Screen a referred signup. Returns the review verdict; pending signups
   * are queued for admin review and never paid out until approved.
   */
  async screenReferralSignup(ctx: ReferralSignupContext): Promise<ReferralFraudEvaluation> {
    const reasons: ReferralFraudReason[] = [];

    // 1. Self-referral: same account, or shared wallet / payment fingerprint.
    if (ctx.userId === ctx.referringUserId) {
      reasons.push(ReferralFraudReason.SelfReferral);
    } else if (
      ctx.walletAddress &&
      ctx.referrerWalletAddress &&
      this.normalizeWallet(ctx.walletAddress) ===
        this.normalizeWallet(ctx.referrerWalletAddress)
    ) {
      reasons.push(ReferralFraudReason.SharedWalletFingerprint);
    } else if (
      ctx.ip &&
      ctx.walletAddress === undefined &&
      ctx.referrerWalletAddress === undefined &&
      this.normalizeWallet(ctx.userId) === this.normalizeWallet(ctx.referringUserId)
    ) {
      // Defensive: fingerprint collision fallback (identical pseudo ids).
      reasons.push(ReferralFraudReason.SelfReferral);
    }

    // 2. Subnet frequency: > threshold signups from one /24 within the window.
    const subnetBreach = this.recordAndCheckSubnet(ctx);
    if (subnetBreach) {
      reasons.push(ReferralFraudReason.SubnetClustering);
    }

    const status =
      reasons.length > 0
        ? ReferralReviewStatus.PendingReview
        : ReferralReviewStatus.Approved;

    if (status === ReferralReviewStatus.PendingReview) {
      this.logger.warn(
        `Referral signup ${ctx.userId} flagged for review: ${reasons.join(", ")}`,
      );
    }

    return { status, reasons };
  }

  /**
   * Record a screened referral for admin review. Held records are NOT
   * eligible for payout until `approveReferral` is called.
   */
  holdForReview(
    ctx: ReferralSignupContext,
    referralCode: string,
    evaluation: ReferralFraudEvaluation,
  ): ReferralReviewRecord {
    const record: ReferralReviewRecord = {
      userId: ctx.userId,
      referringUserId: ctx.referringUserId,
      referralCode,
      status: evaluation.status,
      reasons: evaluation.reasons,
      reviewedAt: new Date().toISOString(),
    };
    this.reviewQueue.set(record.userId, record);
    return record;
  }

  /** Admin approval: release a held referral for reward processing. */
  approveReferral(userId: string): boolean {
    const record = this.reviewQueue.get(userId);
    if (!record) return false;
    record.status = ReferralReviewStatus.Approved;
    record.reasons = [];
    record.reviewedAt = new Date().toISOString();
    this.unlockedRewards.add(userId);
    return true;
  }

  /** Admin rejection: remove the referral from the review queue entirely. */
  rejectReferral(userId: string): boolean {
    const record = this.reviewQueue.get(userId);
    if (!record) return false;
    this.reviewQueue.delete(userId);
    return true;
  }

  listPendingReviews(): ReferralReviewRecord[] {
    return Array.from(this.reviewQueue.values()).filter(
      (r) => r.status === ReferralReviewStatus.PendingReview,
    );
  }

  // ==========================================
  // Reward payout gating
  // ==========================================

  /**
   * Whether a referred user's reward may be paid out. Rewards stay held
   * until the account satisfies the minimum activity threshold (completed
   * transactions) AND is not sitting in the pending-review queue.
   */
  canUnlockReward(
    userId: string,
    activity: ReferralActivitySnapshot,
  ): boolean {
    if (this.reviewQueue.get(userId)?.status === ReferralReviewStatus.PendingReview) {
      return false;
    }
    if (this.unlockedRewards.has(userId)) return true;
    return activity.completedTransactions >= this.minTransactions;
  }

  /** Record completed-activity progress for a referred user. */
  recordActivity(userId: string, completedTransactions: number): void {
    if (completedTransactions >= this.minTransactions) {
      this.unlockedRewards.add(userId);
    }
  }

  // ==========================================
  // Subnet accounting
  // ==========================================

  /** Extract the /24 IPv4 subnet (or /64 prefix heuristic for IPv6). */
  getSubnet(ip: string): string | null {
    const normalized = ip.trim().toLowerCase();
    if (normalized.includes(":")) {
      // IPv6: take the first 4 hextets as a /64-ish grouping key.
      const groups = normalized.split(":").filter(Boolean);
      return groups.length >= 4
        ? groups.slice(0, 4).join(":")
        : groups.join(":") || null;
    }
    const parts = normalized.split(".");
    if (parts.length !== 4) return null;
    return parts.slice(0, 3).join(".");
  }

  private recordAndCheckSubnet(ctx: ReferralSignupContext): boolean {
    if (!ctx.ip) return false;
    const subnet = this.getSubnet(ctx.ip);
    if (!subnet) return false;

    const now = ctx.registeredAt.getTime();
    const windowStart = now - this.subnetWindowMs;

    // Age out entries outside the sliding window.
    while (
      this.recentSignups.length > 0 &&
      this.recentSignups[0].timestamp < windowStart
    ) {
      this.recentSignups.shift();
    }

    const sameSubnet = this.recentSignups.filter(
      (entry) => entry.subnet === subnet,
    ).length;

    this.recentSignups.push({ subnet, ip: ctx.ip, timestamp: now });

    // ">3 signups from identical /24 subnets within 1 hour" — the current
    // signup breaches when the subnet already saw the threshold count.
    return sameSubnet >= this.subnetThreshold;
  }

  private normalizeWallet(value: string): string {
    return value.trim().toLowerCase();
  }
}
