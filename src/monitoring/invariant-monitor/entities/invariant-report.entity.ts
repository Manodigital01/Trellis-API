import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("invariant_reports")
@Index(["generatedAt"])
export class InvariantReportEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @CreateDateColumn()
  generatedAt: Date;

  @Column()
  generatedBy: string;

  @Column({ default: 0 })
  totalChecks: number;

  @Column({ default: 0 })
  passed: number;

  @Column({ default: 0 })
  failed: number;

  @Column({ default: 0 })
  warnings: number;

  @Column({ default: 0 })
  errors: number;

  @Column("jsonb")
  results: any[];

  @Column("text")
  summary: string;

  @Column({ nullable: true })
  category: string | null;
}
