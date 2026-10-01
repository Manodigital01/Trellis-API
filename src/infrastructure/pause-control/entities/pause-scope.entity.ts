import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

@Entity("pause_scopes")
@Index(["scope", "active"])
export class PauseScope {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  @Index()
  scope: string;

  @Column({ default: true })
  active: boolean;

  @Column()
  reason: string;

  @Column()
  activatedBy: string;

  @Column({ nullable: true })
  activatedByRole: string | null;

  @Column({ nullable: true })
  resumedBy: string | null;

  @Column({ nullable: true })
  resumedByRole: string | null;

  @Column({ nullable: true })
  resumeReason: string | null;

  @Column({ nullable: true })
  environment: string | null;

  @Column({ type: "timestamp", nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn()
  activatedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  resumedAt: Date | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
