import { SocialAccount } from "src/core/auth/entities/social-account.entity";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { ProvenanceRecord } from "src/infrastructure/audit/entities/provenance-record.entity";
import { Wallet } from "src/core/auth/entities/wallet.entity";
import { Role, normalizeRole } from "src/common/guard/roles.enum";

/**
 * @deprecated Use the canonical {@link Role} enum from
 * `src/common/guard/roles.enum` instead. `UserRole` is retained as an alias
 * for backwards compatibility with existing imports; it now resolves to the
 * same UPPERCASE-valued enum used by RolesGuard and the JWT claims. Legacy
 * lowercase values stored in the database are coerced on read via
 * {@link normalizeRole}.
 */
export const UserRole = Role;
export type UserRole = Role;

export enum KycStatus {
  UNVERIFIED = "unverified",
  PENDING = "pending",
  IN_REVIEW = "in_review",
  VERIFIED = "verified",
  REJECTED = "rejected",
}

export enum UserStatus {
  PENDING_VERIFICATION = "pending_verification",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  LOCKED = "locked",
  DEACTIVATED = "deactivated",
  ARCHIVED = "archived",
}

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ unique: true, nullable: true })
  username: string | null;

  @Column({ unique: true, nullable: false })
  walletAddress: string;

  @Column({ unique: true, nullable: true })
  email: string | null;

  @Column({ nullable: true })
  password: string | null;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({
    type: "varchar",
    default: Role.USER,
    // Coerce legacy lowercase values (e.g. "admin") persisted before the
    // RBAC canonicalisation into the canonical UPPERCASE Role on read.
    transformer: {
      to: (value?: Role) => value ?? Role.USER,
      from: (value?: string | null) => normalizeRole(value),
    },
  })
  role: Role;

  @Column({
    type: "varchar",
    default: KycStatus.UNVERIFIED,
  })
  kycStatus: KycStatus;

  @Column({ default: false })
  isActive: boolean;

  @Column({
    type: "varchar",
    default: UserStatus.PENDING_VERIFICATION,
    nullable: true,
  })
  lifecycleState?: UserStatus;

  @Column({ type: "timestamp", nullable: true })
  lastLoginAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /**
   * Provenance records associated with this user
   */
  @OneToMany(() => ProvenanceRecord, (provenance) => provenance.user)
  provenanceRecords: ProvenanceRecord[];

  /**
   * Wallets linked to this user account
   */
  @OneToMany(() => Wallet, (wallet) => wallet.user)
  wallets: Wallet[];

  @Column({ unique: true, nullable: true })
  referralCode: string | null;

  @Column({ nullable: true })
  referredById: string | null;

  @ManyToOne(() => User, (user) => user.referrals)
  @JoinColumn({ name: "referredById" })
  referredBy: User | null;

  /**
   * Wallets linked to this user account
   */

  @OneToMany(() => User, (user) => user.referredBy)
  referrals: User[];

  @OneToMany(() => SocialAccount, (social) => social.user)
  socialAccounts: SocialAccount[];
}
