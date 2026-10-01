import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { User, UserStatus } from "./entities/user.entity";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { Role } from "src/common/guard/roles.enum";
import { SensitiveActionAuditService } from "src/infrastructure/audit/sensitive-actions/sensitive-action-audit.service";
import {
  AuditActorType,
  SensitiveActionStatus,
} from "src/infrastructure/audit/entities/sensitive-action-event.entity";
import { SensitiveAction } from "src/infrastructure/audit/sensitive-actions/sensitive-action.enum";
import {
  UserLifecycleState,
  UserStateMachine,
  deriveUserLifecycleState,
} from "src/common/lifecycle/record-state-machines";

/**
 * Pairs of roles that are mutually exclusive and must never be held together.
 * ADMIN and KYC_OPERATOR are kept separate to preserve separation of duties:
 * the account that manages the platform must not also sign off on KYC reviews.
 */
const CONFLICTING_ROLE_PAIRS: [Role, Role][] = [
  [Role.ADMIN, Role.KYC_OPERATOR],
];

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly sensitiveActionAudit: SensitiveActionAuditService,
  ) {}

  create(createUserDto: CreateUserDto) {
    return this.userRepository.save(createUserDto);
  }

  findAll() {
    return this.userRepository.find();
  }

  findOne(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  /** Fetch users in one query for request-scoped relationship loaders. */
  findManyByIds(ids: readonly string[]): Promise<User[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return Promise.resolve([]);
    return this.userRepository.find({ where: { id: In(uniqueIds) } });
  }

  /**
   * Like {@link findOne} but throws {@link NotFoundException} when the user
   * does not exist, so callers can rely on a non-null result.
   */
  async findOneOrFail(id: string): Promise<User> {
    const user = await this.findOne(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    await this.userRepository.update(id, updateUserDto);
    return this.findOne(id);
  }

  remove(id: string) {
    return this.userRepository.delete(id);
  }

  /**
   * Assign a role to a user. Enforces the mutually-exclusive role pairs in
   * {@link CONFLICTING_ROLE_PAIRS} — assigning a role that conflicts with the
   * user's current role throws a BadRequestException.
   */
  async assignRole(
    userId: string,
    newRole: Role,
    auditContext?: { actorId?: string; actorRole?: string; reason?: string },
  ): Promise<User> {
    const user = await this.findOneOrFail(userId);
    const previousRole = user.role;
    if (previousRole === newRole) return user;

    const action =
      newRole === Role.USER
        ? SensitiveAction.ROLE_REVOKED
        : SensitiveAction.ROLE_ASSIGNED;
    const reason =
      auditContext?.reason?.trim() || `Role changed from ${previousRole} to ${newRole}`;
    const auditInput = {
      action,
      actorId: auditContext?.actorId ?? userId,
      actorType: auditContext?.actorId
        ? AuditActorType.MAINTAINER
        : AuditActorType.USER,
      actorRole: auditContext?.actorRole,
      resourceType: "user",
      resourceId: user.id,
      reason,
      beforeState: { role: previousRole },
      afterState: { role: newRole },
    };

    try {
      this.assertNoRoleConflict(previousRole, newRole);
    } catch (error) {
      await this.sensitiveActionAudit.recordSensitiveAction({
        ...auditInput,
        status: SensitiveActionStatus.FAILED,
      });
      throw error;
    }

    user.role = newRole;
    const saved = await this.userRepository.save(user);
    await this.sensitiveActionAudit.recordSensitiveAction(auditInput);
    return saved;
  }

  /**
   * Throws BadRequestException if assigning `newRole` to a user that
   * currently holds `currentRole` would create a conflicting pair.
   */
  assertNoRoleConflict(currentRole: Role, newRole: Role): void {
    if (currentRole === newRole) return;

    const conflict = CONFLICTING_ROLE_PAIRS.some(
      ([a, b]) =>
        (currentRole === a && newRole === b) ||
        (currentRole === b && newRole === a),
    );

    if (conflict) {
      throw new BadRequestException(
        `Role conflict: a user cannot hold both "${currentRole}" and "${newRole}". ` +
          `These roles are mutually exclusive to preserve separation of duties.`,
      );
    }
  }

  /**
   * Guarded deterministic lifecycle transition for User entity.
   */
  async transitionLifecycleState(
    userId: string,
    targetState: UserLifecycleState,
    auditContext?: { actorId?: string; actorRole?: string; reason?: string },
  ): Promise<User> {
    const user = await this.findOneOrFail(userId);
    const currentState = deriveUserLifecycleState(user);

    await UserStateMachine.assertCanTransition(
      currentState,
      targetState,
      auditContext,
      { resourceId: userId, resourceType: "user" },
    );

    const previousLifecycleState = currentState;
    user.lifecycleState = targetState.toLowerCase() as UserStatus;

    if (targetState === UserLifecycleState.ACTIVE) {
      user.isActive = true;
    } else if (
      targetState === UserLifecycleState.SUSPENDED ||
      targetState === UserLifecycleState.LOCKED ||
      targetState === UserLifecycleState.DEACTIVATED ||
      targetState === UserLifecycleState.ARCHIVED
    ) {
      user.isActive = false;
    }

    const saved = await this.userRepository.save(user);

    const action =
      targetState === UserLifecycleState.SUSPENDED
        ? SensitiveAction.USER_SUSPENDED
        : targetState === UserLifecycleState.ACTIVE
        ? SensitiveAction.USER_REACTIVATED
        : targetState === UserLifecycleState.ARCHIVED
        ? SensitiveAction.USER_DELETED
        : SensitiveAction.LIFECYCLE_STATE_TRANSITION;

    await this.sensitiveActionAudit.recordSensitiveAction({
      action,
      actorId: auditContext?.actorId ?? userId,
      actorType: auditContext?.actorId ? AuditActorType.MAINTAINER : AuditActorType.USER,
      actorRole: auditContext?.actorRole,
      resourceType: "user",
      resourceId: user.id,
      reason:
        auditContext?.reason?.trim() ||
        `User lifecycle state transitioned from ${previousLifecycleState} to ${targetState}`,
      beforeState: { lifecycleState: previousLifecycleState, isActive: !user.isActive },
      afterState: { lifecycleState: targetState, isActive: user.isActive },
    });

    return saved;
  }
}
