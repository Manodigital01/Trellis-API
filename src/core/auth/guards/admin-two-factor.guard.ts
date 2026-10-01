import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  Optional,
  Inject,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as speakeasy from "speakeasy";
import { EnhancedAuthService } from "../enhanced-auth.service";
import { User } from "src/core/user/entities/user.entity";
import { TwoFactorAuth, TwoFactorStatus } from "../entities/auth.entity";

interface AuthenticatedPrincipal {
  id?: string;
  sub?: string;
  address?: string;
  role?: string;
  twoFactorVerified?: boolean;
}

export interface RedisLikeClient {
  set(
    key: string,
    value: string,
    mode: "EX",
    ttlSeconds: number,
  ): Promise<unknown>;
  exists(key: string): Promise<number>;
  del?(key: string): Promise<number>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

/**
 * AdminTwoFactorGuard — enforces mandatory two-factor authentication for admin
 * accounts on admin endpoints.
 *
 * Must run AFTER {@link JwtAuthGuard} so `request.user` is populated.
 *
 * Rules (admins only — non-admin principals pass straight through):
 *  1. The admin MUST have 2FA enabled on their account. If not, access is
 *     refused with guidance to enable it.
 *  2. The admin can present a fresh TOTP token in request headers/body or have
 *     an already verified session (`twoFactorVerified`).
 *  3. Replay protection: Any used TOTP token is recorded with a 60-second TTL
 *     and rejected with 401 Unauthorized if replayed.
 *  4. Clock skew tolerance: Configurable +/- 1 step window (30s) is accepted.
 */
@Injectable()
export class AdminTwoFactorGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(AdminTwoFactorGuard.name);
  private clockSkewWindow = 1; // +/- 1 step (30 seconds) tolerance
  private readonly usedTokens = new Map<string, number>(); // key -> expiry epoch ms
  private readonly cleanupIntervalMs = 60 * 1000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly enhancedAuthService: EnhancedAuthService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @Optional()
    @InjectRepository(TwoFactorAuth)
    private readonly twoFactorRepository?: Repository<TwoFactorAuth>,
    @Optional()
    private readonly redisClient?: RedisLikeClient | null,
  ) {
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredTokens(),
      this.cleanupIntervalMs,
    );
    if (typeof this.cleanupTimer?.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /** Configure the clock skew tolerance window (number of 30s steps). */
  setClockSkewWindow(window: number): void {
    this.clockSkewWindow = window;
  }

  getClockSkewWindow(): number {
    return this.clockSkewWindow;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedPrincipal;
      headers?: Record<string, string | string[] | undefined>;
      body?: Record<string, any>;
      query?: Record<string, any>;
    }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException("No authenticated user found on request");
    }

    // Only admin principals are subject to mandatory 2FA enforcement here.
    if (!this.isAdmin(user.role)) {
      return true;
    }

    const userId = await this.resolveUserId(user);
    if (!userId) {
      throw new ForbiddenException("Unable to resolve admin account identity");
    }

    const enabled = await this.enhancedAuthService.isTwoFactorEnabled(userId);
    if (!enabled) {
      this.logger.warn(`Admin ${userId} blocked: 2FA not enabled`);
      throw new ForbiddenException(
        "Admin accounts must enable two-factor authentication before accessing admin endpoints.",
      );
    }

    // Check if a TOTP token was passed directly in the request
    const candidateToken = this.extractTotpToken(request);

    if (candidateToken) {
      // Validate the candidate TOTP token with replay protection & clock skew tolerance
      await this.verifyAndConsumeTotpToken(userId, candidateToken);
      user.twoFactorVerified = true;
      return true;
    }

    if (!user.twoFactorVerified) {
      this.logger.warn(`Admin ${userId} blocked: session not 2FA-verified`);
      throw new ForbiddenException(
        "Two-factor verification required to access admin endpoints.",
      );
    }

    return true;
  }

  /**
   * Verify TOTP token against user secret with clock skew and replay protection.
   * Throws 401 Unauthorized if replayed or invalid.
   */
  async verifyAndConsumeTotpToken(
    userId: string,
    token: string,
    window: number = this.clockSkewWindow,
  ): Promise<boolean> {
    const trimmedToken = token.trim();
    if (!trimmedToken || trimmedToken.length !== 6) {
      throw new UnauthorizedException("Invalid two-factor authentication code");
    }

    // Check replay prevention
    const alreadyUsed = await this.isTokenUsed(userId, trimmedToken);
    if (alreadyUsed) {
      this.logger.warn(`TOTP token replay attempt detected for user ${userId}`);
      throw new UnauthorizedException("TOTP token has already been used");
    }

    const valid = await this.validateTotpCode(userId, trimmedToken, window);
    if (!valid) {
      throw new UnauthorizedException("Invalid two-factor authentication code");
    }

    // Mark as consumed with 60-second TTL
    await this.markTokenUsed(userId, trimmedToken, 60);
    return true;
  }

  /** Check if a TOTP token has already been consumed within TTL. */
  async isTokenUsed(userId: string, token: string): Promise<boolean> {
    const cacheKey = this.getCacheKey(userId, token);

    if (this.redisClient) {
      try {
        const exists = await this.redisClient.exists(cacheKey);
        if (exists > 0) return true;
      } catch (err: any) {
        this.logger.error(
          `Redis TOTP replay lookup failed for ${cacheKey}, checking local cache: ${err?.message}`,
        );
      }
    }

    const localExpiry = this.usedTokens.get(cacheKey);
    if (localExpiry === undefined) return false;
    if (Date.now() > localExpiry) {
      this.usedTokens.delete(cacheKey);
      return false;
    }
    return true;
  }

  /** Record a TOTP token as consumed with a specified TTL (default 60 seconds). */
  async markTokenUsed(
    userId: string,
    token: string,
    ttlSeconds: number = 60,
  ): Promise<void> {
    const cacheKey = this.getCacheKey(userId, token);
    const expiresAt = Date.now() + ttlSeconds * 1000;

    if (this.redisClient) {
      try {
        await this.redisClient.set(cacheKey, "1", "EX", ttlSeconds);
      } catch (err: any) {
        this.logger.error(
          `Redis TOTP mark used failed for ${cacheKey}, falling back to local: ${err?.message}`,
        );
      }
    }

    this.usedTokens.set(cacheKey, expiresAt);
  }

  /** Validate TOTP token against user secret with clock skew window (+/- 1 step). */
  async validateTotpCode(
    userId: string,
    token: string,
    window: number = this.clockSkewWindow,
  ): Promise<boolean> {
    if (
      this.enhancedAuthService &&
      typeof (this.enhancedAuthService as any).validateTotpToken === "function"
    ) {
      const res = await (this.enhancedAuthService as any).validateTotpToken(
        userId,
        token,
        window,
      );
      if (typeof res === "boolean") return res;
    }

    if (this.twoFactorRepository) {
      const twoFactor = await this.twoFactorRepository.findOne({
        where: { userId, isEnabled: true },
      });
      if (!twoFactor || !twoFactor.secret) return false;

      return speakeasy.totp.verify({
        secret: twoFactor.secret,
        encoding: "base32",
        token,
        window,
      });
    }

    return false;
  }

  private extractTotpToken(request: {
    headers?: Record<string, string | string[] | undefined>;
    body?: Record<string, any>;
    query?: Record<string, any>;
  }): string | null {
    const headers = request.headers || {};
    const headerToken =
      headers["x-totp-token"] ||
      headers["x-totp-code"] ||
      headers["x-2fa-token"] ||
      headers["x-2fa-code"] ||
      headers["x-totp"];

    if (typeof headerToken === "string" && headerToken.trim()) {
      return headerToken.trim();
    }
    if (Array.isArray(headerToken) && headerToken[0]?.trim()) {
      return headerToken[0].trim();
    }

    const body = request.body;
    if (body && typeof body === "object") {
      const bodyToken =
        body.totpToken || body.totpCode || body.code || body.totp;
      if (typeof bodyToken === "string" && bodyToken.trim()) {
        return bodyToken.trim();
      }
    }

    const query = request.query;
    if (query && typeof query === "object") {
      const queryToken = query.totpToken || query.totpCode || query.totp;
      if (typeof queryToken === "string" && queryToken.trim()) {
        return queryToken.trim();
      }
    }

    return null;
  }

  private getCacheKey(userId: string, token: string): string {
    return `totp:used:${userId}:${token}`;
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.usedTokens.entries()) {
      if (now > expiresAt) {
        this.usedTokens.delete(key);
      }
    }
  }

  private isAdmin(role?: string): boolean {
    return (role ?? "").toLowerCase() === "admin";
  }

  /**
   * Traditional principals carry the user id directly; wallet principals only
   * carry an address, so resolve it to the owning user id.
   */
  private async resolveUserId(
    user: AuthenticatedPrincipal,
  ): Promise<string | null> {
    if (user.id || user.sub) {
      return user.id ?? user.sub ?? null;
    }

    if (user.address) {
      const owner = await this.userRepository.findOne({
        where: { walletAddress: user.address.toLowerCase() },
      });
      return owner?.id ?? null;
    }

    return null;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
