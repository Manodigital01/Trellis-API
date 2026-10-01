import {
  ReferralFraudService,
  ReferralFraudReason,
  ReferralReviewStatus,
  ReferralSignupContext,
} from "./referral-fraud.service";

function ctx(overrides: Partial<ReferralSignupContext> = {}): ReferralSignupContext {
  return {
    userId: "new-user",
    referringUserId: "referrer",
    ip: "203.0.113.10",
    walletAddress: "0x-new-wallet",
    referrerWalletAddress: "0x-referrer-wallet",
    registeredAt: new Date(),
    ...overrides,
  };
}

describe("ReferralFraudService", () => {
  let service: ReferralFraudService;

  beforeEach(() => {
    service = new ReferralFraudService();
  });

  describe("self-referral detection", () => {
    it("flags a user referring their own account", async () => {
      const evaluation = await service.screenReferralSignup(
        ctx({ userId: "same-id", referringUserId: "same-id" }),
      );
      expect(evaluation.status).toBe(ReferralReviewStatus.PendingReview);
      expect(evaluation.reasons).toContain(ReferralFraudReason.SelfReferral);
    });

    it("flags a secondary account sharing the referrer's wallet fingerprint", async () => {
      const evaluation = await service.screenReferralSignup(
        ctx({
          walletAddress: "0xSAMEWALLET",
          referrerWalletAddress: "0xsamewallet",
        }),
      );
      expect(evaluation.status).toBe(ReferralReviewStatus.PendingReview);
      expect(evaluation.reasons).toContain(
        ReferralFraudReason.SharedWalletFingerprint,
      );
    });

    it("approves a legitimate referral from a distinct wallet", async () => {
      const evaluation = await service.screenReferralSignup(ctx());
      expect(evaluation.status).toBe(ReferralReviewStatus.Approved);
      expect(evaluation.reasons).toHaveLength(0);
    });
  });

  describe("subnet frequency check", () => {
    it("flags when more than 3 signups come from the same /24 subnet within 1 hour", async () => {
      const base = new Date("2026-01-01T10:00:00Z");

      // First 3 signups from 203.0.113.x are within the threshold.
      expect(
        (
          await service.screenReferralSignup(
            ctx({ userId: "u1", ip: "203.0.113.1", registeredAt: base }),
          )
        ).status,
      ).toBe(ReferralReviewStatus.Approved);
      expect(
        (
          await service.screenReferralSignup(
            ctx({ userId: "u2", ip: "203.0.113.2", registeredAt: new Date(base.getTime() + 60_000) }),
          )
        ).status,
      ).toBe(ReferralReviewStatus.Approved);
      expect(
        (
          await service.screenReferralSignup(
            ctx({ userId: "u3", ip: "203.0.113.3", registeredAt: new Date(base.getTime() + 120_000) }),
          )
        ).status,
      ).toBe(ReferralReviewStatus.Approved);

      // 4th signup from the same /24 breaches the threshold.
      const fourth = await service.screenReferralSignup(
        ctx({ userId: "u4", ip: "203.0.113.4", registeredAt: new Date(base.getTime() + 180_000) }),
      );
      expect(fourth.status).toBe(ReferralReviewStatus.PendingReview);
      expect(fourth.reasons).toContain(ReferralFraudReason.SubnetClustering);
    });

    it("does not flag signups spread across different /24 subnets", async () => {
      for (let i = 1; i <= 5; i++) {
        const evaluation = await service.screenReferralSignup(
          ctx({ userId: `u${i}`, ip: `203.0.${i}.1` }),
        );
        expect(evaluation.status).toBe(ReferralReviewStatus.Approved);
      }
    });

    it("stops flagging once the 1-hour window has elapsed", async () => {
      const base = new Date("2026-01-01T10:00:00Z");

      for (let i = 1; i <= 3; i++) {
        await service.screenReferralSignup(
          ctx({
            userId: `u${i}`,
            ip: `203.0.113.${i}`,
            registeredAt: new Date(base.getTime() + i * 60_000),
          }),
        );
      }

      // More than one hour after the last signup: the subnet count has
      // aged out of the trailing window.
      const later = await service.screenReferralSignup(
        ctx({
          userId: "u-later",
          ip: "203.0.113.9",
          registeredAt: new Date(base.getTime() + 64 * 60_000),
        }),
      );
      expect(later.status).toBe(ReferralReviewStatus.Approved);
      expect(later.reasons).not.toContain(ReferralFraudReason.SubnetClustering);
    });

    it("handles signups without an IP address", async () => {
      const evaluation = await service.screenReferralSignup(ctx({ ip: null }));
      expect(evaluation.status).toBe(ReferralReviewStatus.Approved);
    });
  });

  describe("hold-for-review queue", () => {
    it("queues fraudulent signups as pending review and holds payouts", async () => {
      const flagged = ctx({ userId: "bad-user", referringUserId: "bad-user" });
      const evaluation = await service.screenReferralSignup(flagged);
      service.holdForReview(flagged, "CODE1234", evaluation);

      expect(service.listPendingReviews()).toHaveLength(1);
      expect(service.listPendingReviews()[0].referralCode).toBe("CODE1234");
      expect(service.listPendingReviews()[0].status).toBe(
        ReferralReviewStatus.PendingReview,
      );

      // Held referrals cannot be paid out regardless of activity.
      expect(
        service.canUnlockReward("bad-user", { userId: "bad-user", completedTransactions: 10 }),
      ).toBe(false);
    });

    it("releases held referrals on admin approval", async () => {
      const flagged = ctx({ userId: "review-me" });
      const evaluation = await service.screenReferralSignup(flagged);
      service.holdForReview(flagged, "CODE5678", evaluation);
      expect(service.approveReferral("review-me")).toBe(true);
      expect(service.listPendingReviews()).toHaveLength(0);
    });

    it("rejects unknown referrals gracefully", () => {
      expect(service.approveReferral("ghost")).toBe(false);
      expect(service.rejectReferral("ghost")).toBe(false);
    });
  });

  describe("reward activity gating", () => {
    it("holds rewards until the minimum transaction threshold is met", () => {
      expect(
        service.canUnlockReward("new-user", {
          userId: "new-user",
          completedTransactions: 0,
        }),
      ).toBe(false);
      expect(
        service.canUnlockReward("new-user", {
          userId: "new-user",
          completedTransactions: 1,
        }),
      ).toBe(true);
    });

    it("supports a configured threshold higher than one", () => {
      const strict = new ReferralFraudService({ minTransactionsForReward: 3 });
      expect(
        strict.canUnlockReward("u", { userId: "u", completedTransactions: 2 }),
      ).toBe(false);
      expect(
        strict.canUnlockReward("u", { userId: "u", completedTransactions: 3 }),
      ).toBe(true);
    });

    it("unlocks rewards once activity reaches the threshold", () => {
      service.recordActivity("new-user", 1);
      expect(
        service.canUnlockReward("new-user", {
          userId: "new-user",
          completedTransactions: 1,
        }),
      ).toBe(true);
    });
  });
});
