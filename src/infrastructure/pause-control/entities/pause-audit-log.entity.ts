import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("pause_audit_logs")
@Index(["pauseScopeId"])
@Index(["createdAt"])
export class PauseAuditLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  pauseScopeId: string;

  @Column()
  action: string; // 'activate' | 'resume' | 'expire' | 'reject'

  @Column()
  actorId: string;

  @Column()
  actorRole: string;

  @Column()
  reason: string;

  @Column("jsonb", { nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;
}
