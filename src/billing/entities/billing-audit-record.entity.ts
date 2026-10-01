import {
  Entity,
  Column,
  Index,
} from "typeorm";
import { BaseEntity } from "../../common/database/entities/base.entity";
import { ProrationLineItem } from "../billing-proration";

/**
 * Immutable record of one mid-cycle plan change and the proration it settled
 * (issue #82).
 *
 * Every tier switch is money: an upgrade is charged the remaining time on the
 * new tier, a downgrade is credited the unused prepaid value on the old one.
 * Persisting both sides as first-class columns — and the per-line-item detail as
 * `jsonb` — means support can answer "why was I charged this?" from the ledger
 * instead of from server logs, and a dispute can be reconciled against the same
 * arithmetic the service performed.
 *
 * `accountId` is a plain varchar rather than a uuid because billing accepts any
 * opaque account key; several call sites already use non-uuid ids.
 */
@Entity("billing_audit_records")
@Index(["accountId", "effectiveAt"])
@Index(["accountId", "createdAt"])
export class BillingAuditRecord extends BaseEntity {
  @Column({ type: "varchar", length: 255 })
  @Index()
  accountId: string;

  @Column({ type: "varchar", length: 50 })
  fromPlanId: string;

  @Column({ type: "varchar", length: 50 })
  toPlanId: string;

  /** `upgrade` | `downgrade` | `lateral` — the proration direction. */
  @Column({ type: "varchar", length: 20 })
  direction: string;

  /** Instant the new tier took effect. */
  @Column({ type: "timestamptz" })
  effectiveAt: Date;

  @Column({ type: "timestamptz" })
  cycleStart: Date;

  @Column({ type: "timestamptz" })
  cycleEnd: Date;

  /** Length of the billing cycle the proration was measured against, in days. */
  @Column({ type: "double precision" })
  totalCycleDays: number;

  /** Unused slice of that cycle at `effectiveAt`, in days. */
  @Column({ type: "double precision" })
  remainingDays: number;

  /** `remainingDays / totalCycleDays`, kept for replay and audit. */
  @Column({ type: "double precision" })
  remainingFraction: number;

  /** Positive magnitude credited back for the unused old tier. */
  @Column({ type: "integer", default: 0 })
  unusedCreditCents: number;

  /** Positive magnitude charged for the remaining new tier. */
  @Column({ type: "integer", default: 0 })
  newPlanChargeCents: number;

  /** `newPlanChargeCents - unusedCreditCents`; negative means customer credit. */
  @Column({ type: "integer", default: 0 })
  netAmountCents: number;

  @Column({ type: "varchar", length: 3, default: "usd" })
  currency: string;

  /** Per-line proration detail, stored verbatim as the service computed it. */
  @Column({ type: "jsonb" })
  lineItems: ProrationLineItem[];
}
