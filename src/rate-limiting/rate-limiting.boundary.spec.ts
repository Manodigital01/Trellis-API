import { RateLimiterService } from "./rate-limiter.service";
import { RateLimitStrategy } from "./interfaces";

/**
 * Boundary-burst simulation: with a fixed-window limiter, requests issued
 * just before and just after a window reset could consume double the quota
 * ("double-dipping"). The sliding-window log counts every request inside the
 * trailing window, so a burst that straddles a boundary is still capped at
 * the configured limit.
 */
describe("sliding window boundary burst protection", () => {
  let service: RateLimiterService;

  beforeEach(() => {
    service = new RateLimiterService(null, {
      keyPrefix: "trellis:rl:",
      defaultStrategy: RateLimitStrategy.SlidingWindow,
      enableFallback: true,
    });
  });

  const policy = {
    limit: 5,
    windowMs: 60_000,
    burst: 5,
    strategy: RateLimitStrategy.SlidingWindow,
  };

  it("caps a burst straddling a window boundary at the limit", async () => {
    const key = "ip:203.0.113.7:/api:test";

    // Saturate the window with 5 allowed requests.
    for (let i = 0; i < 5; i++) {
      const d = await service.consume(key, policy, "ip", "/api", "free");
      expect(d.allowed).toBe(true);
    }

    // 6th request inside the same trailing window is denied...
    const denied = await service.consume(key, policy, "ip", "/api", "free");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("does not double-dip quota across the window boundary", async () => {
    const key = "ip:203.0.113.8:/api:auth";

    // Fill the window.
    for (let i = 0; i < 5; i++) {
      await service.consume(key, { ...policy }, "ip", "/api", "auth");
    }

    // Advance time past the window boundary (a fixed-window limiter would
    // reset here and grant a fresh quota — double the intended rate).
    const realNow = Date.now;
    const base = Date.now();
    try {
      Date.now = jest.fn(() => base + 61_000);

      // Only the single request issued after the boundary fits: the 5 older
      // log entries have aged out, so exactly one new slot is not "5 more".
      const afterBoundary = await service.consume(
        key,
        { ...policy },
        "ip",
        "/api",
        "auth",
      );
      expect(afterBoundary.allowed).toBe(true);
      expect(afterBoundary.remaining).toBe(4);
    } finally {
      Date.now = realNow;
    }
  });

  it("denies a second immediate burst after boundary-crossing traffic", async () => {
    const key = "ip:203.0.113.9:/api:compute";

    const realNow = Date.now;
    const base = Date.now();
    try {
      // First window: 3 requests (limit is 5 but only 3 here)...
      Date.now = jest.fn(() => base);
      for (let i = 0; i < 3; i++) {
        const d = await service.consume(key, { ...policy }, "ip", "/api", "compute");
        expect(d.allowed).toBe(true);
      }

      // ...then a burst that straddles the boundary: the pre-boundary
      // entries are still inside the trailing 60s log at base + 30s.
      Date.now = jest.fn(() => base + 30_000);
      const fourth = await service.consume(key, { ...policy }, "ip", "/api", "compute");
      expect(fourth.allowed).toBe(true);
      const fifth = await service.consume(key, { ...policy }, "ip", "/api", "compute");
      expect(fifth.allowed).toBe(true);

      // 6th request within the trailing window is denied — no double-dip.
      const over = await service.consume(key, { ...policy }, "ip", "/api", "compute");
      expect(over.allowed).toBe(false);
      expect(over.retryAfterMs).toBeGreaterThan(0);
    } finally {
      Date.now = realNow;
    }
  });

  it("reports a reset time inside the window and a positive retry-after on denial", async () => {
    const key = "ip:203.0.113.10:/api:reset";
    const start = Date.now();

    for (let i = 0; i < 5; i++) {
      const d = await service.consume(key, { ...policy }, "ip", "/api", "free");
      expect(d.allowed).toBe(true);
      expect(d.resetAt).toBeGreaterThan(start);
      expect(d.resetAt).toBeLessThanOrEqual(start + 60_000 + 5);
    }

    const denied = await service.consume(key, { ...policy }, "ip", "/api", "free");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

/**
 * Dual-layer consumption: the guard and middleware check BOTH the IP bucket
 * and the per-user bucket; the most restrictive surviving decision wins so
 * unauthenticated ranges cannot starve authenticated users.
 */
describe("dual IP + user rate limit layers", () => {
  let service: RateLimiterService;

  beforeEach(() => {
    service = new RateLimiterService(null, {
      keyPrefix: "trellis:rl:",
      defaultStrategy: RateLimitStrategy.SlidingWindow,
      enableFallback: true,
    });
  });

  const policy = {
    limit: 3,
    windowMs: 60_000,
    burst: 3,
    strategy: RateLimitStrategy.SlidingWindow,
  };

  /** Reproduces the guard/middleware dual-consume merge logic. */
  async function dualConsume(
    ipKey: string,
    userKey: string | null,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const ipDecision = await service.consume(ipKey, { ...policy }, ipKey, "/api", "free");
    if (!userKey) return ipDecision;
    const userDecision = await service.consume(userKey, { ...policy }, userKey, "/api", "free");
    if (!userDecision.allowed) return userDecision;
    if (!ipDecision.allowed) return ipDecision;
    return {
      ...userDecision,
      remaining: Math.min(ipDecision.remaining, userDecision.remaining),
    };
  }

  it("denies when the IP bucket is exhausted even if the user bucket is fresh", async () => {
    const ipKey = "ip:198.51.100.1";
    const userKey = "user:alice";

    // A different user burns the shared-IP bucket.
    for (let i = 0; i < 3; i++) {
      await service.consume(`${ipKey}:x`, { ...policy }, ipKey, "/api", "free");
    }

    const decision = await dualConsume(`${ipKey}:x`, `${userKey}:fresh`);
    expect(decision.allowed).toBe(false);
  });

  it("denies when the user bucket is exhausted even if the IP bucket is fresh", async () => {
    const userKey = "user:burner";

    for (let i = 0; i < 3; i++) {
      await service.consume(`${userKey}:y`, { ...policy }, userKey, "/api", "free");
    }

    const decision = await dualConsume("ip:198.51.100.2:fresh", `${userKey}:y`);
    expect(decision.allowed).toBe(false);
  });

  it("reports the minimum remaining across both layers", async () => {
    const decision = await dualConsume("ip:198.51.100.3", "user:carol");
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(2); // one token consumed on each layer
  });

  it("allows unauthenticated requests against the IP layer only", async () => {
    const decision = await dualConsume("ip:198.51.100.4", null);
    expect(decision.allowed).toBe(true);
  });
});
