import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Cluster, Redis } from "ioredis";
import { createRedisClient } from "../../common/cache/cache-redis.factory";
import { setDistributedLockManager } from "./distributed-lock.decorator";
import { AcquireOptions, Lock, RedlockClient, RedlockManager } from "./redlock";

/**
 * Owns the Redis connections behind the Redlock manager and registers it for
 * `@DistributedLock`.
 *
 * Nodes come from `REDLOCK_NODES` (comma-separated Redis URLs — use an odd
 * number of *independent* masters, e.g. 3 or 5, for real Redlock fault
 * tolerance), falling back to `REDIS_URL` as a single node. With neither set
 * no manager is registered and decorated methods run uncoordinated, which is
 * the right behaviour for a single-instance deployment.
 */
@Injectable()
export class DistributedLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DistributedLockService.name);
  private clients: Array<Redis | Cluster> = [];
  private manager: RedlockManager | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const urls = this.nodeUrls();
    if (urls.length === 0) {
      this.logger.warn(
        "Neither REDLOCK_NODES nor REDIS_URL is set; distributed locks are disabled",
      );
      return;
    }
    if (urls.length > 1 && urls.length % 2 === 0) {
      this.logger.warn(
        `REDLOCK_NODES has an even number of nodes (${urls.length}); ` +
          "an odd count tolerates the same failures with one fewer node",
      );
    }

    this.clients = urls.map((url, i) => createRedisClient(url, {}, `redlock:${i}`));
    this.manager = new RedlockManager(
      this.clients as unknown as RedlockClient[],
      { keyPrefix: this.config.get<string>("REDLOCK_KEY_PREFIX") ?? "trellis:lock:" },
    );
    setDistributedLockManager(this.manager);
    this.logger.log(
      `Distributed lock manager ready on ${urls.length} node(s), quorum ${this.manager.quorum}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    setDistributedLockManager(null);
    this.manager = null;
    await Promise.all(this.clients.map((c) => c.quit().catch(() => c.disconnect())));
    this.clients = [];
  }

  /** True when locks are coordinated through Redis. */
  isEnabled(): boolean {
    return this.manager !== null;
  }

  /** Acquire a lock imperatively. Null if held elsewhere or locking is disabled. */
  acquire(name: string, ttlMs: number, opts?: AcquireOptions): Promise<Lock | null> {
    return this.manager ? this.manager.acquire(name, ttlMs, opts) : Promise.resolve(null);
  }

  private nodeUrls(): string[] {
    const nodes = this.config.get<string>("REDLOCK_NODES");
    if (nodes) {
      return nodes.split(",").map((u) => u.trim()).filter(Boolean);
    }
    const single = this.config.get<string>("REDIS_URL");
    return single ? [single] : [];
  }
}
