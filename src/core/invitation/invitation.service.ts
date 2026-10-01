import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Invitation } from "./entities/invitation.entity";
import { CreateInvitationDto } from "./dto/create-invitation.dto";
import { InvitationStatus } from "./enums/invitation-status.enum";
import { Role, hasRole } from "../../common/guard/roles.enum";
import * as crypto from "crypto";

@Injectable()
export class InvitationService {
  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
  ) {}

  async create(
    createDto: CreateInvitationDto,
    inviterId: string,
    inviterRole: Role,
  ): Promise<Invitation> {
    // Role escalation validation
    if (!hasRole(inviterRole, createDto.role)) {
      throw new ForbiddenException(
        "Cannot invite a role higher than or equal to yours unless you are an admin. Role escalation is rejected."
      );
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

    const invitation = this.invitationRepository.create({
      email: createDto.email,
      role: createDto.role,
      inviterId,
      token,
      expiresAt,
    });

    return this.invitationRepository.save(invitation);
  }

  async accept(token: string): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({ where: { token } });

    if (!invitation) {
      throw new NotFoundException("Invitation not found");
    }

    if (invitation.status === InvitationStatus.REVOKED) {
      throw new BadRequestException("Invitation is revoked");
    }

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new BadRequestException("Invitation is already accepted");
    }

    if (new Date() > invitation.expiresAt || invitation.status === InvitationStatus.EXPIRED) {
      invitation.status = InvitationStatus.EXPIRED;
      await this.invitationRepository.save(invitation);
      throw new BadRequestException("Invitation has expired");
    }

    invitation.status = InvitationStatus.ACCEPTED;
    return this.invitationRepository.save(invitation);
  }

  async revoke(id: string, inviterId: string, inviterRole: Role): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({ where: { id } });

    if (!invitation) {
      throw new NotFoundException("Invitation not found");
    }

    // Only allow admin or the original inviter to revoke
    if (invitation.inviterId !== inviterId && inviterRole !== Role.ADMIN) {
      throw new ForbiddenException("You don't have permission to revoke this invitation");
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new BadRequestException(`Cannot revoke invitation in status ${invitation.status}`);
    }

    invitation.status = InvitationStatus.REVOKED;
    return this.invitationRepository.save(invitation);
  }
}
