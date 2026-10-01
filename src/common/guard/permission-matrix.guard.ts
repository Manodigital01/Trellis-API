import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Role, normalizeRole } from "./roles.enum";
import { getActionPermissions, isActionAllowed } from "./permission-matrix";

export const ACTION_KEY = "permission_action";

/**
 * Decorator to declare the permission-matrix action required by a route.
 *
 * @example
 * @RequireAction('payment.refund')
 * @Post('refund')
 * refundPayment() { ... }
 */
export const RequireAction = (action: string) =>
  SetMetadata(ACTION_KEY, action);

type AuthenticatedRequest = {
  user?: {
    id?: string;
    address?: string;
    role?: string;
    roles?: string[];
  };
};

@Injectable()
export class PermissionMatrixGuard implements CanActivate {
  private readonly logger = new Logger(PermissionMatrixGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<string>(ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!action) return true;

    const entry = getActionPermissions(action);
    if (!entry) {
      this.logger.warn(`Unknown permission matrix action: ${action}`);
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("No authenticated user found on request");
    }

    const rawRoles: string[] = user.roles ?? (user.role ? [user.role] : []);
    const userRoles: Role[] = rawRoles.map((r) => normalizeRole(r));

    const allowed = isActionAllowed(userRoles, action);

    if (entry.sensitive) {
      this.logger.log(
        `Sensitive action access: action=${action} user=${user.id ?? user.address} ` +
          `roles=[${userRoles.join(",")}] allowed=${allowed}`,
      );
    }

    if (entry.auditRequired) {
      this.eventEmitter.emit("permission.action_checked", {
        action,
        userId: user.id ?? user.address,
        roles: userRoles,
        allowed,
        sensitive: entry.sensitive,
        timestamp: new Date().toISOString(),
      });
    }

    if (!allowed) {
      throw new ForbiddenException(
        `Action '${action}' requires permissions: [${entry.requiredPermissions.join(", ")}]`,
      );
    }

    return true;
  }
}
