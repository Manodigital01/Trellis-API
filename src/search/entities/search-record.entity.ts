import {
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Column,
  Check,
} from "typeorm";

export enum SearchVisibility {
  PRIVATE = "private",
  PUBLIC = "public",
}

@Entity("search_records")
@Check("CHK_search_records_visibility", `"visibility" IN ('private', 'public')`)
@Index(["ownerId", "visibility"])
export class SearchRecord {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column("uuid")
  ownerId: string;

  @Column({ length: 255 })
  title: string;

  @Column({ type: "text" })
  content: string;

  @Column({ type: "varchar", length: 16, default: SearchVisibility.PRIVATE })
  visibility: SearchVisibility;

  @Column({ type: "timestamptz", nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn({ type: "timestamptz", nullable: true })
  deletedAt: Date | null;
}
