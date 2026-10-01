/** Emitted after a referred user has been saved. The user row is the durable attribution record. */
export const REFERRAL_REGISTERED_EVENT = "referral.registered";

export interface ReferralRegisteredEvent {
  userId: string;
  referringUserId: string;
  referralCode: string;
  registeredAt: Date;
  /** Signup IP, used by fraud heuristics for subnet clustering checks. */
  ip?: string | null;
  /** Wallet/payment fingerprint of the new account, for self-referral checks. */
  walletAddress?: string | null;
  /** Wallet/payment fingerprint of the referrer, for self-referral checks. */
  referrerWalletAddress?: string | null;
}
