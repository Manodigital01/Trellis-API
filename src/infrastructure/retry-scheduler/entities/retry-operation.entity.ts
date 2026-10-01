import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum RetryOperationStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  DEAD_LETTER = "dead_letter",
}

@Entity("retry_operations")
@Index(["status", "nextRetryAt"])
@Index(["operationType", "status"])
export class RetryOperation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  @Index()
  operationType: string;

  @Column({ unique: true })
  operationId: string;

  @Column("jsonb")
  payload: any;

  @Column({
    type: "varchar",
    default: RetryOperationStatus.PENDING,
  })
  status: RetryOperationStatus;

  @Column({ default: 0 })
  attempts: number;

  @Column({ default: 3 })
  maxAttempts: number;

  @Column({ type: "text", nullable: true })
  lastError: string | null;

  @Column({ type: "timestamp", nullable: true })
  @Index()
  nextRetryAt: Date | null;

  @Column({ default: 1000 })
  backoffMs: number;

  @Column({ type: "float", default: 2 })
  backoffMultiplier: number;

  @Column({ default: 60000 })
  maxBackoffMs: number;

  @Column({ default: true })
  retryable: boolean;

  @Column({ nullable: true })
  correlationId: string | null;

  @Column("jsonb", { nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  completedAt: Date | null;

  @Column({ type: "timestamp", nullable: true })
  deadLetteredAt: Date | null;
}
