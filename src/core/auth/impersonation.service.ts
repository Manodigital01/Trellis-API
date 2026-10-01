import { Injectable, NotFoundException, UnauthorizedException, ForbiddenException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../user/entities/user.entity";
import { Role } from "../../common/guard/roles.enum";
import { AuditLogService } from "../../infrastructure/audit/audit-log.service";

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async startImpersonation(
    adminId: string,
    targetUserId: string,
    ipAddress: string,
    userAgent?: string,
  ) {
    const adminUser = await this.userRepository.findOne({ where: { id: adminId } });
    if (!adminUser) {
      throw new UnauthorizedException("Admin user not found");
    }

    if (adminUser.role !== Role.ADMIN) {
      throw new ForbiddenException("Only admins can impersonate users");
    }

    const targetUser = await this.userRepository.findOne({ where: { id: targetUserId } });
    if (!targetUser) {
      throw new NotFoundException("Target user not found");
    }

    if (targetUser.role === Role.ADMIN) {
      throw new ForbiddenException("Cannot impersonate another admin");
    }

    // Generate token with impersonatorId
    const payload = {
      sub: targetUser.id,
      email: targetUser.email,
      username: targetUser.username,
      role: targetUser.role,
      impersonatorId: adminUser.id,
      twoFactorVerified: true, // Bypass 2FA for impersonated sessions
    };

    // Duration is limited (e.g. 1 hour)
    const accessToken = this.jwtService.sign(payload, { expiresIn: '1h' });

    await this.auditLogService.record({
      userId: adminId,
      action: "IMPERSONATION_STARTED" as any,
      resourceType: "User",
      resourceId: targetUserId,
      ipAddress,
      userAgent,
      details: `Admin ${adminUser.email} started impersonating user ${targetUser.email}`,
      metadata: { targetUserId, adminId },
    });

    return {
      accessToken,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        role: targetUser.role,
        isImpersonated: true,
      }
    };
  }

  async stopImpersonation(
    adminId: string,
    targetUserId: string,
    ipAddress: string,
    userAgent?: string,
  ) {
    // The actual token revocation can be handled by just letting the frontend discard it,
    // or by TokenBlacklistService if we passed a JTI. For simplicity, the client just discards it.
    // We only need to audit log it.
    await this.auditLogService.record({
      userId: adminId,
      action: "IMPERSONATION_STOPPED" as any,
      resourceType: "User",
      resourceId: targetUserId,
      ipAddress,
      userAgent,
      details: `Admin stopped impersonating user ${targetUserId}`,
      metadata: { targetUserId, adminId },
    });

    return { success: true };
  }
}
