import {
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from "typeorm";

export enum PaymentOperationState {
  CREATING = "CREATING",
  CREATED = "CREATED",
  SIGNED = "SIGNED",
  SUBMITTING = "SUBMITTING",
  SUBMITTED = "SUBMITTED",
  RECOVERY_REQUIRED = "RECOVERY_REQUIRED",
}

@Entity("payment_operations")
@Index(
  "UQ_payment_operations_owner_processor_idempotency",
  ["ownerId", "processorName", "idempotencyKey"],
  { unique: true },
)
@Index("IDX_payment_operations_state_updated", ["state", "updatedAt"])
@Index("IDX_payment_operations_payment_id", ["paymentId"])
export class PaymentOperation {
  @PrimaryGeneratedColumn("uuid")
  operationId: string;

  @Column({ type: "varchar", length: 255 })
  ownerId: string;

  @Column({ type: "varchar", length: 64 })
  processorName: string;

  @Column({ type: "varchar", length: 255 })
  idempotencyKey: string;

  @Column({ type: "varchar", length: 64 })
  requestFingerprint: string;

  @Column({ type: "varchar", length: 32, default: PaymentOperationState.CREATING })
  state: PaymentOperationState;

  @Column({ type: "varchar", length: 255, nullable: true })
  paymentId: string | null;

  @Column({ type: "jsonb", nullable: true })
  createdPayment: Record<string, unknown> | null;

  @Column({ type: "text", nullable: true })
  signedPayload: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  signerAddress: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  transactionHash: string | null;

  @Column({ type: "jsonb", nullable: true })
  submittedTransaction: Record<string, unknown> | null;

  @Column({ type: "text", nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}