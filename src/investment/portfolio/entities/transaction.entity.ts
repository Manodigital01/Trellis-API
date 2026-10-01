import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Portfolio } from "./portfolio.entity";
import { PortfolioAsset } from "./portfolio-asset.entity";
import { Chain } from "./portfolio-asset.entity";

export enum TransactionType {
  BUY = "buy",
  SELL = "sell",
  DEPOSIT = "deposit",
  WITHDRAWAL = "withdrawal",
  TRANSFER_IN = "transfer_in",
  TRANSFER_OUT = "transfer_out",
  SWAP = "swap",
  REBALANCE = "rebalance",
  DIVIDEND = "dividend",
  INTEREST = "interest",
  OTHER = "other",
}

export enum TransactionStatus {
  PENDING = "pending",
  SUBMITTED = "submitted",
  CONFIRMED = "confirmed",
  FAILED = "failed",
  CANCELLED = "cancelled",
  TIMED_OUT = "timed_out",
  REVERTED = "reverted",
}

@Entity("transactions")
@Index(["portfolioId", "createdAt"])
@Index(["portfolioId", "type"])
@Index(["portfolioId", "chain"])
@Index(["portfolioAssetId"])
export class Transaction {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({
    type: "enum",
    enum: TransactionType,
  })
  type: TransactionType;

  @Column({
    type: "enum",
    enum: TransactionStatus,
    default: TransactionStatus.CONFIRMED,
  })
  status: TransactionStatus;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  date: Date;

  @Column({ type: "decimal", precision: 18, scale: 8 })
  amount: number;

  @Column({ type: "decimal", precision: 18, scale: 8, nullable: true })
  price: number;

  @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
  fees: number;

  @Column({
    type: "enum",
    enum: Chain,
    default: Chain.OTHER,
  })
  chain: Chain;

  @Column({ type: "text", nullable: true })
  notes: string;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  // Relations
  @ManyToOne(() => Portfolio, (portfolio) => portfolio.transactions, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "portfolioId" })
  portfolio: Portfolio;

  @Column("uuid")
  portfolioId: string;

  @ManyToOne(() => PortfolioAsset, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "portfolioAssetId" })
  portfolioAsset: PortfolioAsset | null;

  @Column("uuid", { nullable: true })
  portfolioAssetId: string | null;
}
