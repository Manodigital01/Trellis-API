import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { Role } from "../../../common/guard/roles.enum";
import { InvitationStatus } from "../enums/invitation-status.enum";

@Entity("invitations")
export class Invitation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  @Index()
  email: string;

  @Column({
    type: "enum",
    enum: Role,
    default: Role.USER,
  })
  role: Role;

  @Column()
  inviterId: string;

  @Column()
  @Index({ unique: true })
  token: string;

  @Column({
    type: "enum",
    enum: InvitationStatus,
    default: InvitationStatus.PENDING,
  })
  status: InvitationStatus;

  @Column()
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
