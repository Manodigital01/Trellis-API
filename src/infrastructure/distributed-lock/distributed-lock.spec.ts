import { Cron, CronExpression } from "@nestjs/schedule";
import { SCHEDULE_CRON_OPTIONS } from "@nestjs/schedule/dist/schedule.constants";
import {
  DistributedLock,
  getDistributedLockManager,
  setDistributedLockManager,
} from "./distributed-lock.decorator";
import {
  EXTEND_SCRIPT,
  LockAcquisitionError,
  RELEASE_SCRIPT,
  RedlockClient,
  RedlockManager,
} from "./redlock";

/**
 * In-memory stand-in for one Redis master. Several app "nodes" (managers)
 * share the same FakeRedisNode instances, exactly as several API replicas
 * share the same Redis servers.
 */
class FakeRedisNode implements RedlockClient {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  down = false;

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): string | undefined {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, _px: "PX", ttlMs: number, _nx: "NX") {
    if (this.down) throw new Error("ECONNREFUSED");
    if (this.live(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  async eval(script: string, _numKeys: number, key: string, token: string, ttl?: number) {
    if (this.down) throw new Error("ECONNREFUSED");
    const entry = this.live(key as string);
    if (!entry || entry.value !== token) return 0;
    if (script === RELEASE_SCRIPT) {
      this.store.delete(key);
      return 1;
    }
    if (script === EXTEND_SCRIPT) {
      entry.expiresAt = Date.now() + Number(ttl);
      return 1;
    }
    throw new Error("unknown script");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("RedlockManager", () => {
  let nodes: FakeRedisNode[];
  let nodeA: RedlockManager;
  let nodeB: RedlockManager;

  beforeEach(() => {
    nodes = [new FakeRedisNode(), new FakeRedisNode(), new FakeRedisNode()];
    nodeA = new RedlockManager(nodes);
    nodeB = new RedlockManager(nodes);
  });

  it("requires a majority quorum", () => {
    expect(nodeA.quorum).toBe(2);
    expect(new RedlockManager([new FakeRedisNode()]).quorum).toBe(1);
    expect(new RedlockManager(Array.from({ length: 5 }, () => new FakeRedisNode())).quorum).toBe(3);
  });

  it("rejects an empty node list and invalid TTLs", async () => {
    expect(() => new RedlockManager([])).toThrow();
    await expect(nodeA.acquire("job", 0)).rejects.toThrow(/positive/);
  });

  it("second node fails to acquire while the first holds the lock", async () => {
    const lock = await nodeA.acquire("billing:daily", 5_000);
    expect(lock).not.toBeNull();
    expect(lock!.isValid()).toBe(true);

    expect(await nodeB.acquire("billing:daily", 5_000)).toBeNull();
    await expect(nodeB.acquireOrThrow("billing:daily", 5_000)).rejects.toBeInstanceOf(
      LockAcquisitionError,
    );
  });

  it("lets another node acquire immediately after release", async () => {
    const lock = await nodeA.acquire("job", 5_000);
    await lock!.release();

    expect(lock!.isValid()).toBe(false);
    for (const n of nodes) expect(n.get("trellis:lock:job")).toBeUndefined();
    expect(await nodeB.acquire("job", 5_000)).not.toBeNull();
  });

  it("expires automatically when the holder crashes without releasing", async () => {
    // Node A "crashes": acquires and never releases or extends.
    expect(await nodeA.acquire("job", 40)).not.toBeNull();
    expect(await nodeB.acquire("job", 40)).toBeNull();

    await sleep(60);
    expect(await nodeB.acquire("job", 5_000)).not.toBeNull();
  });

  it("never releases a lock that has since been taken by another node", async () => {
    const stale = await nodeA.acquire("job", 30);
    await sleep(50);
    const fresh = await nodeB.acquire("job", 5_000);
    expect(fresh).not.toBeNull();

    await stale!.release();
    expect(await nodeA.acquire("job", 5_000)).toBeNull();
    expect(nodes[0].get("trellis:lock:job")).toBe(fresh!.token);
  });

  it("extends a held lock past its original TTL", async () => {
    const lock = await nodeA.acquire("job", 60);
    await sleep(30);
    expect(await lock!.extend(200)).toBe(true);
    await sleep(60);
    expect(await nodeB.acquire("job", 5_000)).toBeNull();
  });

  it("cannot extend a lock it no longer owns", async () => {
    const lock = await nodeA.acquire("job", 20);
    await sleep(40);
    await nodeB.acquire("job", 5_000);
    expect(await lock!.extend(1_000)).toBe(false);
  });

  it("tolerates a minority of nodes being down", async () => {
    nodes[2].down = true;
    expect(await nodeA.acquire("job", 5_000)).not.toBeNull();
    expect(await nodeB.acquire("job", 5_000)).toBeNull();
  });

  it("fails without quorum and rolls back partial acquisitions", async () => {
    nodes[1].down = true;
    nodes[2].down = true;
    expect(await nodeA.acquire("job", 5_000)).toBeNull();
    expect(nodes[0].get("trellis:lock:job")).toBeUndefined();
  });

  it("does not let a split vote grant the lock to either contender", async () => {
    // Node 0 already holds a foreign token; A gets node 1, B gets node 2.
    await nodes[0].set("trellis:lock:job", "someone-else", "PX", 5_000, "NX");
    await nodes[1].set("trellis:lock:job", "a", "PX", 5_000, "NX");
    expect(await nodeB.acquire("job", 5_000)).toBeNull();
    expect(nodes[2].get("trellis:lock:job")).toBeUndefined();
  });

  it("treats a hung node as a failed vote", async () => {
    const hung: RedlockClient = {
      set: () => new Promise(() => undefined),
      eval: () => new Promise(() => undefined),
    };
    const manager = new RedlockManager([nodes[0], nodes[1], hung], { nodeTimeoutMs: 20 });
    expect(await manager.acquire("job", 5_000)).not.toBeNull();
  });

  it("retries until the lock frees up", async () => {
    const lock = await nodeA.acquire("job", 5_000);
    setTimeout(() => void lock!.release(), 30);
    const acquired = await nodeB.acquire("job", 5_000, {
      retryCount: 10,
      retryDelayMs: 10,
      retryJitterMs: 1,
    });
    expect(acquired).not.toBeNull();
  });

  it("using() runs the callback under the lock and always releases", async () => {
    await expect(
      nodeA.using("job", 5_000, async () => {
        expect(await nodeB.acquire("job", 5_000)).toBeNull();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await nodeB.acquire("job", 5_000)).not.toBeNull();
    expect(await nodeA.using("job", 5_000, () => 1)).toEqual({ acquired: false });
  });
});

describe("@DistributedLock", () => {
  let nodes: FakeRedisNode[];
  let managerA: RedlockManager;
  let managerB: RedlockManager;

  class BillingJob {
    runs = 0;
    gate: Promise<void> = Promise.resolve();

    @DistributedLock("billing:daily-run", 5_000)
    async runDailyBilling(): Promise<string> {
      this.runs++;
      await this.gate;
      return "charged";
    }

    @DistributedLock("billing:strict", 5_000, { onLocked: "throw" })
    async strict(): Promise<void> {
      await this.gate;
    }

    @DistributedLock("billing:failing", 5_000)
    async failing(): Promise<void> {
      throw new Error("payment provider down");
    }

    @DistributedLock((tenantId: string) => `billing:tenant:${tenantId}`, 5_000)
    async perTenant(_tenantId: string): Promise<void> {
      await this.gate;
    }

    @DistributedLock("billing:long", 60, { autoExtend: true })
    async longRunning(): Promise<void> {
      await this.gate;
    }
  }

  /** Invoke `fn` as if running on the app node that owns `manager`. */
  function onNode<T>(manager: RedlockManager, fn: () => Promise<T>): Promise<T> {
    setDistributedLockManager(manager);
    // The decorator reads the manager synchronously at call time.
    return fn();
  }

  beforeEach(() => {
    nodes = [new FakeRedisNode(), new FakeRedisNode(), new FakeRedisNode()];
    managerA = new RedlockManager(nodes);
    managerB = new RedlockManager(nodes);
  });

  afterEach(() => setDistributedLockManager(null));

  it("executes on exactly one node while the first is still running", async () => {
    const node1 = new BillingJob();
    const node2 = new BillingJob();
    const gate = deferred();
    node1.gate = gate.promise;

    const first = onNode(managerA, () => node1.runDailyBilling());
    await sleep(5); // let node1 acquire and enter the method body
    const second = await onNode(managerB, () => node2.runDailyBilling());

    expect(second).toBeUndefined();
    expect(node2.runs).toBe(0);

    gate.resolve();
    expect(await first).toBe("charged");
    expect(node1.runs).toBe(1);
  });

  it("releases the lock as soon as the method completes", async () => {
    const node1 = new BillingJob();
    const node2 = new BillingJob();

    await onNode(managerA, () => node1.runDailyBilling());
    for (const n of nodes) expect(n.get("trellis:lock:billing:daily-run")).toBeUndefined();

    expect(await onNode(managerB, () => node2.runDailyBilling())).toBe("charged");
    expect(node2.runs).toBe(1);
  });

  it("releases the lock and rethrows when the method fails", async () => {
    const job = new BillingJob();
    await expect(onNode(managerA, () => job.failing())).rejects.toThrow("payment provider down");
    expect(await managerB.acquire("billing:failing", 1_000)).not.toBeNull();
  });

  it("throws LockAcquisitionError with onLocked: 'throw'", async () => {
    const node1 = new BillingJob();
    const node2 = new BillingJob();
    const gate = deferred();
    node1.gate = gate.promise;

    const first = onNode(managerA, () => node1.strict());
    await sleep(5);
    await expect(onNode(managerB, () => node2.strict())).rejects.toBeInstanceOf(
      LockAcquisitionError,
    );
    gate.resolve();
    await first;
  });

  it("derives the key from arguments when given a function", async () => {
    const job = new BillingJob();
    const gate = deferred();
    job.gate = gate.promise;

    const t1 = onNode(managerA, () => job.perTenant("t1"));
    await sleep(5);
    expect(nodes[0].get("trellis:lock:billing:tenant:t1")).toBeDefined();
    // A different tenant is a different lock.
    expect(await managerB.acquire("billing:tenant:t2", 1_000)).not.toBeNull();
    expect(await managerB.acquire("billing:tenant:t1", 1_000)).toBeNull();
    gate.resolve();
    await t1;
  });

  it("keeps extending the lock while a long task runs", async () => {
    const node1 = new BillingJob();
    const gate = deferred();
    node1.gate = gate.promise;

    const first = onNode(managerA, () => node1.longRunning());
    await sleep(150); // well past the 60ms TTL
    expect(await managerB.acquire("billing:long", 1_000)).toBeNull();

    gate.resolve();
    await first;
    expect(await managerB.acquire("billing:long", 1_000)).not.toBeNull();
  });

  it("runs uncoordinated when no manager is registered (single-node mode)", async () => {
    setDistributedLockManager(null);
    expect(getDistributedLockManager()).toBeNull();
    const job = new BillingJob();
    expect(await job.runDailyBilling()).toBe("charged");
  });

  it("rejects a non-positive TTL at decoration time", () => {
    expect(() => DistributedLock("x", 0)).toThrow(/positive/);
  });

  it("preserves @Cron metadata in either decorator order", () => {
    class Jobs {
      @Cron(CronExpression.EVERY_HOUR)
      @DistributedLock("cron-outer", 1_000)
      async cronOuter() {}

      @DistributedLock("lock-outer", 1_000)
      @Cron(CronExpression.EVERY_HOUR)
      async lockOuter() {}
    }
    for (const fn of [Jobs.prototype.cronOuter, Jobs.prototype.lockOuter]) {
      expect(Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, fn)).toEqual(
        expect.objectContaining({ cronTime: CronExpression.EVERY_HOUR }),
      );
    }
    expect(Jobs.prototype.cronOuter.name).toBe("cronOuter");
  });
});
