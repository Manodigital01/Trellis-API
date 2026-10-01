import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { User } from "src/core/user/entities/user.entity";

@Entity("refresh_tokens")
export class RefreshToken {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ unique: true })
  token: string;

  @Column({ type: "timestamp" })
  expiresAt: Date;

  @Column({ default: false })
  revoked: boolean;

  @Column({ nullable: true })
  revokedAt: Date;

  @Column({ nullable: true })
  replacedByToken: string;

  /**
   * Issue #144: every refresh token descended from one login shares a
   * `familyId`. Rotation already revokes the token it replaces, but nothing
   * links the chain together, so a stolen-then-replayed token is merely
   * rejected rather than being recognised as a replay. With the family id,
   * presenting an already-revoked token identifies the whole family and the
   * entire set is revoked at once.
   *
   * Nullable so rows predating this column remain valid; such a token simply
   * has no family and cannot participate in family-wide revocation.
   */
  @Column({ type: "uuid", nullable: true })
  @Index()
  familyId?: string;

  @Column()
  ipAddress: string;

  @Column({ nullable: true })
  userAgent: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

export enum TwoFactorType {
  TOTP = "totp",
  SMS = "sms",
  EMAIL = "email",
}

export enum TwoFactorStatus {
  PENDING = "pending",
  VERIFIED = "verified",
  DISABLED = "disabled",
}

@Entity("two_factor_auth")
export class TwoFactorAuth {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "userId" })
  user: User;

  @Column({ type: "varchar", default: TwoFactorType.TOTP })
  type: TwoFactorType;

  @Column({ type: "varchar", default: TwoFactorStatus.PENDING })
  status: TwoFactorStatus;

  @Column({ nullable: true })
  secret: string;

  @Column({ nullable: true })
  backupCodes: string; // JSON array of SHA-256 hashed, single-use backup codes

  @Column({ nullable: true })
  phoneNumber: string;

  @Column({ default: false })
  isEnabled: boolean;

  /**
   * Number of consecutive failed verification attempts. Reset to 0 on success.
   * Used to enforce account lockout after repeated failures.
   */
  @Column({ type: "int", default: 0 })
  failedAttempts: number;

  /**
   * When set and in the future, 2FA verification is locked out until this time.
   */
  @Column({ type: "timestamp", nullable: true })
  lockedUntil: Date | null;

  @Column({ type: "timestamp", nullable: true })
  verifiedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  lastUsedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
