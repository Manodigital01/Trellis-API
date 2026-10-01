import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Entity("sensitive_action_chain_heads")
export class SensitiveActionChainHead {
  @PrimaryColumn({ type: "varchar", length: 32 })
  id: string;

  @Column({ type: "bigint" })
  sequence: string;

  @Column({ type: "varchar", length: 64 })
  eventHash: string;

  @Column({ type: "varchar", length: 255 })
  lastEventId: string;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date;
}