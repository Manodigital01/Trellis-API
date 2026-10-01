import { randomBytes } from "crypto";

/**
 * Redlock distributed lock manager (https://redis.io/docs/manual/patterns/distributed-locks/).
 *
 * A lock is held when a majority (N/2 + 1) of independent Redis masters
 * accepted `SET key token NX PX ttl` within the lock's validity window. The
 * random token makes release and extension safe: a node only deletes or
 * extends the key if it still holds *our* token, so a process whose lock
 * already expired can never release a lock someone else has since taken.
 *
 * Crash safety comes from the TTL alone — nothing has to run for a dead
 * process's lock to go away.
 *
 * Implemented directly on ioredis rather than via the `redlock` npm package:
 * v4 pins ioredis 4 typings and v5 has been in beta for years. The algorithm
 * is small enough that owning it is the lower-risk option.
 *
 * Issue #139.
 */

/** The subset of the ioredis client (standalone or Cluster) the manager uses. */
export interface RedlockClient {
  set(
    key: string,
    value: string,
    px: "PX",
    ttlMs: number,
    nx: "NX",
  ): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedlockOptions {
  /** Prefix applied to every lock key. Default: "trellis:lock:". */
  keyPrefix?: string;
  /** Additional acquisition attempts after the first. Default: 0 (try once). */
  retryCount?: number;
  /** Base delay between attempts. Default: 200ms. */
  retryDelayMs?: number;
  /** Random jitter added to each delay to de-synchronise contenders. Default: 100ms. */
  retryJitterMs?: number;
  /** Clock drift allowance as a fraction of TTL. Default: 0.01. */
  driftFactor?: number;
  /** Upper bound on how long a single node may take to answer. Default: 500ms. */
  nodeTimeoutMs?: number;
}

export interface AcquireOptions {
  retryCount?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
}

export class LockAcquisitionError extends Error {
  constructor(readonly key: string) {
    super(`Could not acquire distributed lock "${key}": held by another node`);
    this.name = "LockAcquisitionError";
  }
}

/** Delete the key only if it still holds our token. */
export const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Reset the TTL only if the key still holds our token. */
export const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

/** A held lock. Obtain via {@link RedlockManager.acquire}. */
export class Lock {
  private released = false;

  constructor(
    private readonly manager: RedlockManager,
    readonly key: string,
    readonly token: string,
    public expiresAt: number,
  ) {}

  /** True until the validity window elapses or the lock is released. */
  isValid(): boolean {
    return !this.released && Date.now() < this.expiresAt;
  }

  /** Push the expiry out to `ttlMs` from now. Returns false if quorum was lost. */
  async extend(ttlMs: number): Promise<boolean> {
    if (this.released) return false;
    const expiresAt = await this.manager.extendRaw(this.key, this.token, ttlMs);
    if (expiresAt === null) return false;
    this.expiresAt = expiresAt;
    return true;
  }

  /** Release on every node. Idempotent. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.manager.releaseRaw(this.key, this.token);
  }
}

const DEFAULTS: Required<RedlockOptions> = {
  keyPrefix: "trellis:lock:",
  retryCount: 0,
  retryDelayMs: 200,
  retryJitterMs: 100,
  driftFactor: 0.01,
  nodeTimeoutMs: 500,
};

export class RedlockManager {
  private readonly options: Required<RedlockOptions>;
  readonly quorum: number;

  constructor(
    private readonly clients: RedlockClient[],
    options: RedlockOptions = {},
  ) {
    if (clients.length === 0) {
      throw new Error("RedlockManager requires at least one Redis client");
    }
    this.options = { ...DEFAULTS, ...options };
    this.quorum = Math.floor(clients.length / 2) + 1;
  }

  /** Fully-qualified Redis key for a lock name. */
  keyFor(name: string): string {
    return `${this.options.keyPrefix}${name}`;
  }

  /**
   * Try to take the lock. Resolves to a {@link Lock} or null when another
   * holder has it (or too few nodes answered) after all retries.
   */
  async acquire(name: string, ttlMs: number, opts: AcquireOptions = {}): Promise<Lock | null> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Lock TTL must be a positive number of ms (got ${ttlMs})`);
    }
    const key = this.keyFor(name);
    const retryCount = opts.retryCount ?? this.options.retryCount;
    const retryDelayMs = opts.retryDelayMs ?? this.options.retryDelayMs;
    const retryJitterMs = opts.retryJitterMs ?? this.options.retryJitterMs;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const token = randomBytes(16).toString("hex");
      const start = Date.now();
      const votes = await this.onAllNodes((c) =>
        c.set(key, token, "PX", ttlMs, "NX").then((r) => r === "OK"),
      );
      const expiresAt = start + ttlMs - this.drift(ttlMs);

      if (votes >= this.quorum && Date.now() < expiresAt) {
        return new Lock(this, key, token, expiresAt);
      }

      // Undo partial acquisitions so the minority nodes don't block others
      // until TTL.
      await this.releaseRaw(key, token);

      if (attempt < retryCount) {
        await sleep(retryDelayMs + Math.floor(Math.random() * retryJitterMs));
      }
    }
    return null;
  }

  /** Like {@link acquire} but throws {@link LockAcquisitionError} instead of returning null. */
  async acquireOrThrow(name: string, ttlMs: number, opts?: AcquireOptions): Promise<Lock> {
    const lock = await this.acquire(name, ttlMs, opts);
    if (!lock) throw new LockAcquisitionError(name);
    return lock;
  }

  /**
   * Run `fn` while holding the lock; always release afterwards. Returns
   * `{ acquired: false }` without running `fn` if the lock is held elsewhere.
   */
  async using<T>(
    name: string,
    ttlMs: number,
    fn: (lock: Lock) => Promise<T> | T,
    opts?: AcquireOptions,
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const lock = await this.acquire(name, ttlMs, opts);
    if (!lock) return { acquired: false };
    try {
      return { acquired: true, result: await fn(lock) };
    } finally {
      await lock.release();
    }
  }

  /** @internal Used by {@link Lock.extend}. */
  async extendRaw(key: string, token: string, ttlMs: number): Promise<number | null> {
    const start = Date.now();
    const votes = await this.onAllNodes((c) =>
      c.eval(EXTEND_SCRIPT, 1, key, token, ttlMs).then((r) => Number(r) === 1),
    );
    const expiresAt = start + ttlMs - this.drift(ttlMs);
    return votes >= this.quorum && Date.now() < expiresAt ? expiresAt : null;
  }

  /** @internal Used by {@link Lock.release}. Best effort on every node. */
  async releaseRaw(key: string, token: string): Promise<void> {
    await this.onAllNodes((c) =>
      c.eval(RELEASE_SCRIPT, 1, key, token).then(() => true),
    );
  }

  private drift(ttlMs: number): number {
    // +2ms for Redis's own expiry precision, per the Redlock spec.
    return Math.floor(ttlMs * this.options.driftFactor) + 2;
  }

  /** Run `op` against every node in parallel; count successes. Never throws. */
  private async onAllNodes(op: (c: RedlockClient) => Promise<boolean>): Promise<number> {
    const results = await Promise.all(
      this.clients.map((c) =>
        withTimeout(op(c), this.options.nodeTimeoutMs).catch(() => false),
      ),
    );
    return results.filter(Boolean).length;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Redis node timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
