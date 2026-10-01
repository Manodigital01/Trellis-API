import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PauseControlService } from "./pause-control.service";
import { Role, normalizeRole } from "src/common/guard/roles.enum";
import { PausableScope } from "./dto/activate-pause.dto";

export const PAUSABLE_SCOPE_KEY = "pausable_scope";

/**
 * Decorator to mark a route as subject to pause control.
 *
 * @example
 * @PausableOperation(PausableScope.TRADING)
 * @Post('execute')
 * executeTrade() { ... }
 */
export const PausableOperation = (scope: PausableScope) =>
  SetMetadata(PAUSABLE_SCOPE_KEY, scope);

type AuthenticatedRequest = {
  user?: {
    id?: string;
    role?: string;
    roles?: string[];
  };
};

@Injectable()
export class PauseControlGuard implements CanActivate {
  private readonly logger = new Logger(PauseControlGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly pauseService: PauseControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<PausableScope>(
      PAUSABLE_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!scope) return true;

    // ADMIN users bypass pause checks
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (user) {
      const rawRoles: string[] =
        user.roles ?? (user.role ? [user.role] : []);
      const userRoles = rawRoles.map((r) => normalizeRole(r));
      if (userRoles.includes(Role.ADMIN)) return true;
    }

    const { paused, reason, expiresAt } =
      await this.pauseService.isOperationPaused(scope);

    if (paused) {
      const response = context.switchToHttp().getResponse();
      if (expiresAt && response.setHeader) {
        const retryAfter = Math.max(
          1,
          Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
        );
        response.setHeader("Retry-After", String(retryAfter));
      }

      this.logger.warn(
        `Operation rejected: scope=${scope} paused. Reason: ${reason}`,
      );

      throw new ServiceUnavailableException(
        `This operation is temporarily paused. Reason: ${reason ?? "maintenance"}. Please try again later.`,
      );
    }

    return true;
  }
}
