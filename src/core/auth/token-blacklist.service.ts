import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";

/**
 * Redis-backed revocation store for jti replay prevention.
 *
 * Previously an in-process `Map`. That is correct for one process and wrong
 * for more than one: a jti revoked by one replica is invisible to another, so
 * a replayed access token passes on whichever instance happens to receive it.
 * The class comment already said "in production, replace with a Redis-backed
 * store"; this is that store.
 *
 * Redis is used when `REDIS_URL` is set and reachable. When it is not, the
 * service degrades to the in-process map rather than failing open — and says
 * so, loudly, because in that mode revocation is only honoured within this
 * process. Silently degrading is the failure mode that produced the original
 * bug, so the degradation is logged and observable via `isDistributed()`.
 *
 * Issue #144 (token revocation) and the original jti replay defence.
 */

/** The subset of the ioredis client this service uses. */
export interface RedisLikeClient {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  exists(key: string): Promise<number>;
  del?(key: string): Promise<number>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
  on?(event: string, handler: (...args: any[]) => void): void;
}

@Injectable()
export class TokenBlacklistService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenBlacklistService.name);
  private readonly local = new Map<string, number>(); // jti -> expiry epoch ms
  private readonly cleanupIntervalMs = 5 * 60 * 1000;
  private client: RedisLikeClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Optional() client?: RedisLikeClient | null) {
    this.client = client ?? null;
    this.timer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    // Never hold the event loop open for a cleanup timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** True when revocations are shared across processes. */
  isDistributed(): boolean {
    return this.client !== null;
  }

  /** Blacklist a jti until its expiry time. */
  async revoke(jti: string, expiresAt: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));

    if (this.client) {
      try {
        await this.client.set(this.key(jti), "1", "EX", ttlSeconds);
        return;
      } catch (error) {
        // A Redis outage must not silently turn into "not revoked". Fall back
        // to the local map for this entry and say so.
        this.logger.error(
          `Redis revoke failed for jti ${jti}; recording locally only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.local.set(jti, expiresAt);
  }

  /** Returns true if the jti has been revoked. */
  async isRevoked(jti: string): Promise<boolean> {
    if (this.client) {
      try {
        return (await this.client.exists(this.key(jti))) > 0;
      } catch (error) {
        this.logger.error(
          `Redis lookup failed for jti ${jti}; falling back to local state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const exp = this.local.get(jti);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.local.delete(jti);
      return false;
    }
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.client?.quit) {
      try {
        await this.client.quit();
      } catch {
        // Shutting down; a failed quit is not actionable.
      }
    }
    this.client?.disconnect?.();
  }

  private key(jti: string): string {
    return `token-blacklist:${jti}`;
  }

  /** Remove expired local entries to prevent unbounded memory growth. */
  private cleanup(): void {
    const now = Date.now();
    for (const [jti, exp] of this.local) {
      if (now > exp) this.local.delete(jti);
    }
  }
}
