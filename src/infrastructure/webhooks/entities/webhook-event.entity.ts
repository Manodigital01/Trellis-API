import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export enum WebhookEventStatus {
  PENDING = "pending",
  DELIVERING = "delivering",
  DELIVERED = "delivered",
  FAILED = "failed",
}

@Entity("webhook_events")
@Index(
  "UQ_webhook_events_subscription_external_id",
  ["sourceSubscriptionId", "externalEventId"],
  {
    unique: true,
    where:
      '"sourceSubscriptionId" IS NOT NULL AND "externalEventId" IS NOT NULL',
  },
)
export class WebhookEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  @Index()
  eventType: string;

  @Column({ type: "uuid", nullable: true })
  sourceSubscriptionId: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  externalEventId: string | null;

  @Column({ type: "jsonb" })
  payload: Record<string, any>;

  @Column({ type: "varchar", length: 255, nullable: true })
  @Index()
  aggregateId?: string;

  @Column({
    type: "enum",
    enum: WebhookEventStatus,
    default: WebhookEventStatus.PENDING,
  })
  status: WebhookEventStatus;

  @Column({ type: "int", default: 0 })
  deliveryCount: number;

  @Column({ type: "int", default: 0 })
  successCount: number;

  @Column({ type: "int", default: 0 })
  failureCount: number;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
