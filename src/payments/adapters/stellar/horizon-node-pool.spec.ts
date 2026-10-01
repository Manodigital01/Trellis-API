import { HorizonNodePool, isTransientHorizonError } from "./horizon-node-pool";

/** Minimal ConfigService stand-in backed by a plain record. */
function fakeConfig(env: Record<string, unknown>): any {
  return {
    get: (key: string) => env[key],
  };
}

describe("HorizonNodePool", () => {
  describe("node configuration", () => {
    it("uses the primary from STELLAR_HORIZON_URL when set", () => {
      const pool = new HorizonNodePool(
        fakeConfig({ STELLAR_HORIZON_URL: "https://primary.example" }),
      );
      expect(pool.primaryUrl).toBe("https://primary.example");
      expect(pool.getNodes().map((n) => n.url)).toEqual([
        "https://primary.example",
      ]);
    });

    it("falls back to the testnet default when nothing is configured", () => {
      const pool = new HorizonNodePool(fakeConfig({}));
      expect(pool.primaryUrl).toBe("https://horizon-testnet.stellar.org");
    });

    it("parses comma-separated fallback URLs in order", () => {
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_URL: "https://primary.example",
          STELLAR_HORIZON_FALLBACK_URLS:
            "https://secondary.example, https://tertiary.example",
        }),
      );
      expect(pool.getNodes().map((n) => n.url)).toEqual([
        "https://primary.example",
        "https://secondary.example",
        "https://tertiary.example",
      ]);
    });

    it("drops fallbacks that duplicate the primary", () => {
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_URL: "https://primary.example",
          STELLAR_HORIZON_FALLBACK_URLS:
            "https://primary.example,https://other.example",
        }),
      );
      expect(pool.getNodes().map((n) => n.url)).toEqual([
        "https://primary.example",
        "https://other.example",
      ]);
    });

    it("applies the documented defaults for timeout, retries and backoff", () => {
      const pool = new HorizonNodePool(fakeConfig({}));
      expect(pool.timeout).toBe(5000);
      expect(pool.maxAttempts).toBe(2);
      expect(pool.backoffBase).toBe(100);
    });

    it("honours configured overrides", () => {
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_TIMEOUT_MS: "8000",
          STELLAR_HORIZON_MAX_RETRIES: "3",
          STELLAR_HORIZON_BACKOFF_BASE_MS: "250",
        }),
      );
      expect(pool.timeout).toBe(8000);
      expect(pool.maxAttempts).toBe(3);
      expect(pool.backoffBase).toBe(250);
    });
  });

  describe("health tracking and failover ordering", () => {
    it("orders healthy candidates primary-first", () => {
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_URL: "https://primary.example",
          STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
        }),
      );
      expect(pool.getCandidateUrls()).toEqual([
        "https://primary.example",
        "https://secondary.example",
      ]);
    });

    it("skips a failed node until its cooldown elapses, then retries it", () => {
      let now = 1_000_000;
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_URL: "https://primary.example",
          STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
          STELLAR_HORIZON_HEALTH_TTL_MS: "1000",
        }),
        { now: () => now },
      );

      pool.markFailure("https://primary.example");
      expect(pool.getCandidateUrls()).toEqual(["https://secondary.example"]);

      // Still inside the cooldown.
      now += 999;
      expect(pool.getCandidateUrls()).toEqual(["https://secondary.example"]);

      // Cooldown elapsed — the node is eligible again and resumes its
      // configured priority (primary first).
      now += 1;
      expect(pool.getCandidateUrls()).toEqual([
        "https://primary.example",
        "https://secondary.example",
      ]);
    });

    it("restores a node immediately after a success", () => {
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_URL: "https://primary.example",
          STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
        }),
      );
      pool.markFailure("https://primary.example");
      expect(pool.getCandidateUrls()).toEqual(["https://secondary.example"]);

      pool.markSuccess("https://primary.example");
      expect(pool.getCandidateUrls()).toEqual([
        "https://primary.example",
        "https://secondary.example",
      ]);
    });

    it("still returns the primary when every node is in cooldown", () => {
      const pool = new HorizonNodePool(
        fakeConfig({
          STELLAR_HORIZON_URL: "https://primary.example",
          STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
        }),
      );
      pool.markFailure("https://primary.example");
      pool.markFailure("https://secondary.example");
      expect(pool.getCandidateUrls()).toEqual([
        "https://primary.example",
        "https://secondary.example",
      ]);
    });
  });

  describe("isTransientHorizonError", () => {
    it("treats per-attempt timeouts as transient", () => {
      const err = new Error("timed out");
      err.name = "HorizonRequestTimeoutError";
      expect(isTransientHorizonError(err)).toBe(true);
    });

    it("treats 429 and 5xx as transient", () => {
      expect(isTransientHorizonError({ status: 429 })).toBe(true);
      expect(isTransientHorizonError({ response: { status: 503 } })).toBe(true);
      expect(isTransientHorizonError({ code: 500 })).toBe(true);
    });

    it("treats 4xx as permanent", () => {
      expect(isTransientHorizonError({ status: 400 })).toBe(false);
      expect(isTransientHorizonError({ response: { status: 404 } })).toBe(
        false,
      );
    });

    it("treats network-level error codes as transient", () => {
      expect(isTransientHorizonError({ code: "ECONNRESET" })).toBe(true);
      expect(isTransientHorizonError({ code: "ECONNABORTED" })).toBe(true);
      expect(isTransientHorizonError({ code: "ENOTFOUND" })).toBe(true);
    });

    it("matches network failures described in the message", () => {
      expect(isTransientHorizonError(new Error("socket hang up"))).toBe(true);
      expect(isTransientHorizonError(new Error("Network Error"))).toBe(true);
      expect(isTransientHorizonError(new Error("request timed out"))).toBe(
        true,
      );
    });

    it("treats everything else as permanent", () => {
      expect(isTransientHorizonError(new Error("tx_failed"))).toBe(false);
      expect(isTransientHorizonError("nope")).toBe(false);
      expect(isTransientHorizonError(undefined)).toBe(false);
    });
  });
});
