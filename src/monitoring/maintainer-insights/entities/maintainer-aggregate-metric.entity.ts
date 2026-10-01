import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Persisted aggregate metric snapshot computed from privacy-scrubbed events.
 * Stored strictly by safe dimensions without raw sensitive or PII data.
 */
@Entity("maintainer_aggregate_metrics")
@Index(["dateBucket", "granularity", "operation"])
@Index(["dateBucket", "network"])
@Index(["dateBucket", "statusCategory"])
export class MaintainerAggregateMetric {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Truncated start of time bucket (hour or day UTC) */
  @Column({ type: "timestamp" })
  @Index()
  dateBucket: Date;

  /** Granularity: 'hourly' or 'daily' */
  @Column({ type: "varchar", length: 20 })
  @Index()
  granularity: "hourly" | "daily";

  /** Whitelisted business/protocol operation */
  @Column({ type: "varchar", length: 100 })
  @Index()
  operation: string;

  /** Normalized route pattern, e.g. /api/v1/oracle/payloads */
  @Column({ type: "varchar", length: 255, default: "/unmatched" })
  route: string;

  /** Coarse status category: '2xx' | '4xx' | '5xx' | 'other' */
  @Column({ type: "varchar", length: 10 })
  statusCategory: string;

  /** Canonical HTTP or protocol status code (e.g. 200, 400, 500) */
  @Column({ type: "int", default: 200 })
  statusCode: number;

  /** Standardized sanitized error category */
  @Column({ type: "varchar", length: 50, default: "NONE" })
  errorCategory: string;

  /** Safe client tier (e.g. 'agent', 'operator', 'web', 'sdk') */
  @Column({ type: "varchar", length: 30, default: "unknown" })
  clientType: string;

  /** Network environment ('mainnet', 'testnet', 'sandbox') */
  @Column({ type: "varchar", length: 30, default: "unknown" })
  network: string;

  /** High-level role/actor type ('user', 'service_actor', 'operator', 'admin', 'system') */
  @Column({ type: "varchar", length: 30, default: "anonymous" })
  actorType: string;

  /** Total event count in this bucket */
  @Column({ type: "int", default: 0 })
  totalEvents: number;

  /** Successful event count */
  @Column({ type: "int", default: 0 })
  successCount: number;

  /** Failed event count */
  @Column({ type: "int", default: 0 })
  failureCount: number;

  /** Distinct anonymized active actors in this bucket (cardinality only) */
  @Column({ type: "int", default: 0 })
  uniqueActorsCount: number;

  /** Statistical latency distributions in milliseconds */
  @Column({ type: "float", default: 0 })
  avgLatencyMs: number;

  @Column({ type: "float", default: 0 })
  minLatencyMs: number;

  @Column({ type: "float", default: 0 })
  maxLatencyMs: number;

  @Column({ type: "float", default: 0 })
  p50LatencyMs: number;

  @Column({ type: "float", default: 0 })
  p90LatencyMs: number;

  @Column({ type: "float", default: 0 })
  p99LatencyMs: number;

  /** Safe distribution of error categories { [errorCategory]: count } */
  @Column({ type: "jsonb", nullable: true })
  errorBreakdown: Record<string, number>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
