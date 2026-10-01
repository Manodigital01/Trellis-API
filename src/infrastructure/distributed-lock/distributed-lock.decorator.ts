import { Logger } from "@nestjs/common";
import "reflect-metadata";
import { LockAcquisitionError, RedlockManager } from "./redlock";

/**
 * `@DistributedLock('key', ttlMs)` — run the decorated method on at most one
 * node of the cluster at a time.
 *
 * ```ts
 * @Cron(CronExpression.EVERY_DAY_AT_2AM)
 * @DistributedLock("billing:daily-run", 10 * 60_000)
 * async runDailyBilling() { ... }
 * ```
 *
 * Every node's scheduler still fires; the first node to win the Redlock
 * quorum runs the body and the rest return `undefined` (or throw, with
 * `onLocked: "throw"`). The lock is released as soon as the method settles.
 * While the method is running the lock is extended every `ttlMs / 2`, so a
 * long run keeps it — but if the process dies, extension stops and the lock
 * expires after at most `ttlMs`.
 *
 * Works in either order relative to `@Cron` / `@Interval`: metadata on the
 * original method is copied onto the wrapper.
 */

export interface DistributedLockOptions {
  /** What to do when another node holds the lock. Default: "skip". */
  onLocked?: "skip" | "throw";
  /** Keep the lock alive while the method runs. Default: true. */
  autoExtend?: boolean;
  /** Acquisition retries before giving up. Default: 0 — crons shouldn't queue. */
  retryCount?: number;
  retryDelayMs?: number;
}

export type LockKey = string | ((...args: any[]) => string);

const logger = new Logger("DistributedLock");
let registeredManager: RedlockManager | null = null;
let warnedNoManager = false;

/**
 * Install the manager used by every `@DistributedLock` method. Called by
 * DistributedLockService on module init; pass null to unregister.
 */
export function setDistributedLockManager(manager: RedlockManager | null): void {
  registeredManager = manager;
  warnedNoManager = false;
}

export function getDistributedLockManager(): RedlockManager | null {
  return registeredManager;
}

export function DistributedLock(
  key: LockKey,
  ttlMs: number,
  options: DistributedLockOptions = {},
): MethodDecorator {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`@DistributedLock TTL must be a positive number of ms (got ${ttlMs})`);
  }
  const { onLocked = "skip", autoExtend = true, retryCount = 0, retryDelayMs } = options;

  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: any[]) => any;
    const label = `${target.constructor.name}.${String(propertyKey)}`;

    const wrapped = async function (this: unknown, ...args: any[]) {
      // Read at call time so the manager can be installed after decoration.
      const manager = registeredManager;
      if (!manager) {
        // No Redis configured: a single-node deployment. Running is correct
        // there, but make it visible in case this is a misconfigured cluster.
        if (!warnedNoManager) {
          warnedNoManager = true;
          logger.warn(
            "No distributed lock manager registered (Redis not configured); " +
              "@DistributedLock methods run without cluster coordination",
          );
        }
        return original.apply(this, args);
      }

      const name = typeof key === "function" ? key(...args) : key;
      const lock = await manager.acquire(name, ttlMs, { retryCount, retryDelayMs });
      if (!lock) {
        if (onLocked === "throw") throw new LockAcquisitionError(name);
        logger.debug(`Skipping ${label}: lock "${name}" is held by another node`);
        return undefined;
      }

      let timer: ReturnType<typeof setInterval> | null = null;
      if (autoExtend) {
        timer = setInterval(() => {
          lock.extend(ttlMs).then(
            (ok) => {
              if (!ok) {
                logger.error(
                  `Lost lock "${name}" while ${label} was still running; ` +
                    "another node may start the same task",
                );
              }
            },
            () => undefined,
          );
        }, Math.max(1, Math.floor(ttlMs / 2)));
        if (typeof timer.unref === "function") timer.unref();
      }

      try {
        return await original.apply(this, args);
      } finally {
        if (timer) clearInterval(timer);
        await lock.release().catch((err: unknown) =>
          logger.warn(
            `Failed to release lock "${name}" (it will expire in ≤${ttlMs}ms): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    };

    // Preserve @Cron / @Interval / other metadata regardless of decorator order.
    for (const metaKey of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(metaKey, Reflect.getMetadata(metaKey, original), wrapped);
    }
    Object.defineProperty(wrapped, "name", { value: original.name });

    descriptor.value = wrapped;
    return descriptor;
  };
}
