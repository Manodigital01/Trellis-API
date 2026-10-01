import { Column, Entity, Index } from "typeorm";
import { BaseEntity } from "../../../common/database/entities/base.entity";
import {
  SensitiveAction,
  SensitiveActionScope,
} from "../sensitive-actions/sensitive-action.enum";

export enum AuditActorType {
  USER = "user",
  MAINTAINER = "maintainer",
  SERVICE = "service",
  SYSTEM = "system",
}

export enum SensitiveActionStatus {
  SUCCEEDED = "succeeded",
  FAILED = "failed",
}

/**
 * Append-only, tamper-evident record of one sensitive action.
 *
 * `sequence` is a monotonic counter and `eventHash` chains to `previousHash`,
 * so any edit, reorder, or deletion of a historical row is detectable through
 * `SensitiveActionAuditService.verifyChain()`. Unlike the general audit log,
 * these rows are never purged by the retention job, which is what keeps the
 * chain verifiable.
 */
@Entity("sensitive_action_events")
@Index(["sequence"], { unique: true })
@Index(["actorId", "occurredAt"])
@Index(["action", "occurredAt"])
@Index(["scope", "occurredAt"])
@Index(["resourceType", "resourceId", "occurredAt"])
export class SensitiveActionEvent extends BaseEntity {
  /** Monotonic position in the chain; starts at 1. */
  @Column({ type: "bigint" })
  sequence: string;

  @Column({ type: "varchar", length: 64 })
  actorId: string;

  @Column({ type: "varchar", length: 16, default: AuditActorType.USER })
  actorType: AuditActorType;

  /** Role held at the time of the action, e.g. `admin` or `compliance_officer`. */
  @Column({ type: "varchar", length: 64, nullable: true })
  actorRole: string | null;

  @Column({ type: "varchar", length: 100 })
  action: SensitiveAction;

  @Column({ type: "varchar", length: 64 })
  scope: SensitiveActionScope;

  @Column({ type: "varchar", length: 100, nullable: true })
  resourceType: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  resourceId: string | null;

  /** Mandatory for actions with `reasonRequired: true` in the catalogue. */
  @Column({ type: "text", nullable: true })
  reason: string | null;

  /** Sanitized snapshot before the action; only for `capturesState` actions. */
  @Column({ type: "jsonb", nullable: true })
  beforeState: Record<string, unknown> | null;

  /** Sanitized snapshot after the action; only for `capturesState` actions. */
  @Column({ type: "jsonb", nullable: true })
  afterState: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({
    type: "varchar",
    length: 16,
    default: SensitiveActionStatus.SUCCEEDED,
  })
  status: SensitiveActionStatus;

  @Column({ type: "varchar", length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  userAgent: string | null;

  /** JSON paths replaced with `[REDACTED]` by the sanitizer, for reviewers. */
  @Column({ type: "jsonb", nullable: true })
  redactedPaths: string[] | null;

  @Column({ type: "timestamptz" })
  occurredAt: Date;

  /** SHA-256 over the hash-relevant fields, including `previousHash`. */
  @Column({ type: "varchar", length: 64 })
  eventHash: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  previousHash: string | null;
}
