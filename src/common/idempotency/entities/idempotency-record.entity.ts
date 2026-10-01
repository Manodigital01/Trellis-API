import { Column, Entity, Index } from "typeorm";
import { BaseEntity } from "../../database/entities/base.entity";

export enum IdempotencyRecordStatus {
  /** The original request is being processed; a concurrent retry must be rejected. */
  IN_PROGRESS = "in_progress",
  /** The request finished successfully and its response is replayable. */
  COMPLETED = "completed",
  /** The request threw; the same key may be retried with the same payload. */
  FAILED = "failed",
}

/**
 * Durable record of one idempotent request.
 *
 * `(scope, idempotencyKey)` is unique so two concurrent requests with the same
 * key can never both execute their handler: the loser fails on the unique index
 * and is mapped to a 409 by `IdempotencyService`.
 */
@Entity("idempotency_records")
@Index(["scope", "idempotencyKey"], { unique: true })
@Index(["expiresAt"])
export class IdempotencyRecord extends BaseEntity {
  /** `METHOD:/route:actor` - keeps keys from leaking across routes or users. */
  @Column({ type: "varchar", length: 255 })
  scope: string;

  @Column({ type: "varchar", length: 128 })
  idempotencyKey: string;

  /** SHA-256 of the canonicalized request (params, query, body). */
  @Column({ type: "varchar", length: 64 })
  requestHash: string;

  @Column({
    type: "varchar",
    length: 16,
    default: IdempotencyRecordStatus.IN_PROGRESS,
  })
  status: IdempotencyRecordStatus;

  @Column({ type: "integer", nullable: true })
  responseCode: number | null;

  /** Stored as `{ payload }` so any JSON response shape can be replayed verbatim. */
  @Column({ type: "jsonb", nullable: true })
  responseBody: Record<string, unknown> | null;

  @Column({ type: "text", nullable: true })
  failureReason: string | null;

  @Column({ type: "timestamptz" })
  expiresAt: Date;
}
