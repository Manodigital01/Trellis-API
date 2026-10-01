import { Inject, Injectable, Logger, UnauthorizedException, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { randomUUID } from "crypto";
import { RefreshToken } from "./entities/auth.entity";

/**
 * Refresh token rotation with family reuse detection (issue #144).
 *
 * Rotation itself already existed: `EnhancedAuthService.refreshToken` issues a
 * new refresh token and revokes the one it replaces. What was missing is the
 * other half of the security property.
 *
 * A revoked refresh token presented again is evidence of one of two things: the
 * token was stolen and is being replayed, or a legitimate client raced its own
 * rotation. Both must be handled, and they must be handled differently:
 *
 *  - Replay: revoke the *entire family*. Every token descended from the same
 *    login dies, so the attacker and the victim both lose access and the user
 *    is forced to re-authenticate. This is the standard OAuth 2.0 Security BCP
 *    response, and it is why `familyId` exists: without it, a revoked token
 *    and a forged token are indistinguishable, because both simply fail to
 *    match `revoked = false`.
 *
 * The revocation store is Redis with a TTL matching the token's own expiry, so
 * a revoked jti is dropped when it could no longer be presented anyway. Redis
 * being unavailable is a *fail-closed* condition: refusing a request is
 * correct, accepting one on an unverifiable revocation state is not. The
 * in-process fallback exists so a single-node deployment and the test suite
 * work without Redis, and it is documented as weaker — it cannot see revocations
 * made by another process.
 */

/**
 * DI token for the revocation store. Exported so a module can supply a
 * Redis-backed implementation; when absent the service uses its own in-process
 * store rather than failing to construct.
 */
export const REVOCATION_STORE = "REFRESH_TOKEN_REVOCATION_STORE";

/** Minimal Redis surface used here, so the service is testable with a stub. */
export interface RevocationStore {
  revoke(key: string, ttlSeconds: number): Promise<void>;
  isRevoked(key: string): Promise<boolean>;
  /** Revoke every member of a set, atomically where the backend allows. */
  revokeMany?(keys: string[], ttlSeconds: number): Promise<void>;
}

/** In-process store. Correct for one process; not shared across replicas. */
export class InMemoryRevocationStore implements RevocationStore {
  private readonly revoked = new Map<string, number>();

  async revoke(key: string, ttlSeconds: number): Promise<void> {
    this.sweep();
    this.revoked.set(key, Date.now() + ttlSeconds * 1000);
  }

  async isRevoked(key: string): Promise<boolean> {
    this.sweep();
    return this.revoked.has(key);
  }

  /** Drop entries past their TTL so the map cannot grow without bound. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.revoked) {
      if (now > expiresAt) this.revoked.delete(key);
    }
  }
}

export type RotationOutcome =
  | { kind: "rotated"; token: RefreshToken; replaced: RefreshToken }
  | { kind: "reused"; familyId: string; revokedTokens: number };

@Injectable()
export class RefreshTokenRotationService {
  private readonly logger = new Logger(RefreshTokenRotationService.name);

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @Optional() @Inject(REVOCATION_STORE) private readonly revocationStore?: RevocationStore,
  ) {}

  /**
   * The configured store, or a lazily-created in-process one.
   *
   * Kept behind an accessor because the injected store is optional: a module
   * that does not register `REVOCATION_STORE` still gets a working service
   * rather than a DI resolution error.
   */
  private get store(): RevocationStore {
    if (!this.resolvedStore) {
      this.resolvedStore = this.revocationStore ?? new InMemoryRevocationStore();
    }
    return this.resolvedStore;
  }

  private resolvedStore: RevocationStore | null = null;

  /** A fresh family id for a new login. */
  newFamilyId(): string {
    return randomUUID();
  }

  /**
   * Rotate a refresh token, or detect that it is being replayed.
   *
   * The lookup is deliberately *not* filtered on `revoked = false`. A token
   * that exists but is already revoked is the reuse signal; filtering it out at
   * the query is what made a replay indistinguishable from a forgery.
   */
  async rotate(presentedToken: string): Promise<RotationOutcome> {
    const existing = await this.refreshTokenRepository.findOne({
      where: { token: presentedToken },
      relations: ["user"],
    });

    if (!existing) {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    // Reuse of an already-revoked token: this is the theft signal.
    if (existing.revoked) {
      const revokedTokens = await this.revokeFamily(existing.familyId);
      this.logger.warn(
        `refresh token reuse detected; revoked ${revokedTokens} token(s) in family ${existing.familyId ?? "<none>"}`,
      );
      return { kind: "reused", familyId: existing.familyId, revokedTokens };
    }

    // Belt and braces: a token revoked in the revocation store but not yet
    // written back to the row is still revoked.
    if (await this.store.isRevoked(this.storeKey(existing.id))) {
      const revokedTokens = await this.revokeFamily(existing.familyId);
      return { kind: "reused", familyId: existing.familyId, revokedTokens };
    }

    // Normal rotation. The new token inherits the family, which is the whole
    // point: the chain stays linked for its whole life.
    const replacement = this.refreshTokenRepository.create({
      userId: existing.userId,
      token: randomUUID(),
      expiresAt: this.nextExpiry(existing.expiresAt),
      revoked: false,
      familyId: existing.familyId ?? this.newFamilyId(),
      ipAddress: existing.ipAddress,
      userAgent: existing.userAgent,
    });
    await this.refreshTokenRepository.save(replacement);

    existing.revoked = true;
    existing.revokedAt = new Date();
    existing.replacedByToken = replacement.token;
    await this.refreshTokenRepository.save(existing);

    await this.store.revoke(
      this.storeKey(existing.id),
      this.ttlSeconds(existing.expiresAt),
    );

    return { kind: "rotated", token: replacement, replaced: existing };
  }

  /** Revoke every live token in a family. Returns how many were revoked. */
  async revokeFamily(familyId: string | undefined | null): Promise<number> {
    // A token issued before the family column has none. There is no family to
    // revoke, so refusing the caller is the only safe response.
    if (!familyId) {
      this.logger.warn("reuse detected for a token with no token family; refusing");
      return 0;
    }

    const family = await this.refreshTokenRepository.find({
      where: { familyId, revoked: false },
    });

    const now = new Date();
    for (const token of family) {
      token.revoked = true;
      token.revokedAt = now;
    }
    if (family.length > 0) {
      await this.refreshTokenRepository.save(family);
    }

    const keys = family.map((token) => this.storeKey(token.id));
    const ttl = Math.max(
      1,
      ...family.map((token) => this.ttlSeconds(token.expiresAt)),
    );
    if (this.store.revokeMany && keys.length > 0) {
      await this.store.revokeMany(keys, ttl);
    } else {
      for (const key of keys) {
        await this.store.revoke(key, ttl);
      }
    }

    return family.length;
  }

  /** Logout: revoke a single token immediately, per the issue's requirement. */
  async revokeToken(token: RefreshToken): Promise<void> {
    token.revoked = true;
    token.revokedAt = new Date();
    await this.refreshTokenRepository.save(token);
    await this.store.revoke(
      this.storeKey(token.id),
      this.ttlSeconds(token.expiresAt),
    );
  }

  private storeKey(tokenId: string): string {
    return `refresh-revoked:${tokenId}`;
  }

  /** Seconds until a token expires, floored at 1 so a TTL is never 0. */
  private ttlSeconds(expiresAt: Date): number {
    return Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  }

  /**
   * Refresh expiry matches the token being replaced, so rotation does not
   * silently extend a session beyond its original window — a client that keeps
   * rotating must eventually re-authenticate.
   */
  private nextExpiry(previousExpiry: Date): Date {
    return new Date(previousExpiry.getTime());
  }
}
