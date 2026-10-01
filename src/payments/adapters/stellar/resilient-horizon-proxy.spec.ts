import { Horizon } from "@stellar/stellar-sdk";
import {
  ResilientHorizonProxy,
  HorizonRequestTimeoutError,
} from "./resilient-horizon-proxy";
import { HorizonNodePool } from "./horizon-node-pool";

type AnyServer = Record<string, any>;

/** Build a fake Horizon.Server whose builder chains resolve to `result`. */
function fakeServer(
  result: unknown,
  opts?: { failWith?: unknown; hangForever?: boolean },
): AnyServer {
  const call = jest.fn().mockImplementation(() => {
    if (opts?.hangForever) {
      return new Promise(() => undefined); // never settles: exercises the timeout race
    }
    if (opts?.failWith !== undefined) {
      return Promise.reject(opts.failWith);
    }
    return Promise.resolve(result);
  });
  return {
    loadAccount: jest.fn().mockReturnValue({ call }),
    submitTransaction: call,
    transactions: jest.fn().mockReturnValue({
      transaction: jest.fn().mockReturnValue({ call }),
    }),
  } as AnyServer;
}

function makePool(env: Record<string, unknown>): HorizonNodePool {
  return new HorizonNodePool({
    get: (key: string) => env[key],
  } as any);
}

describe("ResilientHorizonProxy", () => {
  it("serves a successful request from the primary without failover", async () => {
    const servers = new Map([
      ["https://primary.example", fakeServer({ ok: true })],
    ]);
    const pool = makePool({ STELLAR_HORIZON_URL: "https://primary.example" });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    const result = await proxy.execute((server) =>
      server.transactions().transaction("hash-1").call(),
    );

    expect(result).toEqual({ ok: true });
    expect(proxy.getFailoverLog()).toEqual([]);
  });

  it("fails over to the secondary when the primary times out (>5s knob)", async () => {
    const primary = fakeServer(undefined, { hangForever: true });
    const secondary = fakeServer({ ok: true, from: "secondary" });
    const servers = new Map<string, AnyServer>([
      ["https://primary.example", primary],
      ["https://secondary.example", secondary],
    ]);
    const pool = makePool({
      STELLAR_HORIZON_URL: "https://primary.example",
      STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
      STELLAR_HORIZON_TIMEOUT_MS: "20", // simulated 5s timeout, scaled down for the test
      STELLAR_HORIZON_BACKOFF_BASE_MS: "0",
    });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    const result = await proxy.execute((server) =>
      server.transactions().transaction("hash-1").call(),
    );

    expect(result).toEqual({ ok: true, from: "secondary" });
    expect(proxy.getFailoverLog()).toEqual([
      "https://primary.example -> https://secondary.example",
    ]);
    expect(
      pool.getNodes().find((n) => n.url === "https://primary.example")!.healthy,
    ).toBe(false);
    expect(
      pool.getNodes().find((n) => n.url === "https://secondary.example")!
        .healthy,
    ).toBe(true);
  });

  it("retries with backoff on the same node before failing over", async () => {
    let calls = 0;
    const flaky: AnyServer = {
      transactions: jest.fn().mockReturnValue({
        transaction: jest.fn().mockImplementation(() => ({
          call: jest.fn().mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
              throw Object.assign(new Error("socket hang up"), {
                code: "ECONNRESET",
              });
            }
            return { ok: true, attempt: calls };
          }),
        })),
      }),
    };
    const servers = new Map([["https://primary.example", flaky]]);
    const pool = makePool({
      STELLAR_HORIZON_URL: "https://primary.example",
      STELLAR_HORIZON_MAX_RETRIES: "3",
      STELLAR_HORIZON_BACKOFF_BASE_MS: "0",
    });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    const result = await proxy.execute((server) =>
      server.transactions().transaction("h").call(),
    );

    expect(result).toEqual({ ok: true, attempt: 2 });
    expect(proxy.getFailoverLog()).toEqual([]);
  });

  it("throws the original error when every node fails transiently", async () => {
    const boom = Object.assign(new Error("primary down"), { status: 503 });
    const servers = new Map<string, AnyServer>([
      ["https://primary.example", fakeServer(undefined, { failWith: boom })],
      [
        "https://secondary.example",
        fakeServer(undefined, {
          failWith: Object.assign(new Error("secondary down"), { status: 503 }),
        }),
      ],
    ]);
    const pool = makePool({
      STELLAR_HORIZON_URL: "https://primary.example",
      STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
      STELLAR_HORIZON_BACKOFF_BASE_MS: "0",
    });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    await expect(
      proxy.execute((server) => server.transactions().transaction("h").call()),
    ).rejects.toThrow("primary down");
  });

  it("does not fail over on deterministic errors (failed transaction)", async () => {
    const primary = fakeServer(undefined, {
      failWith: Object.assign(new Error("tx_failed"), { status: 400 }),
    });
    const secondary = jest.fn();
    const servers = new Map<string, AnyServer>([
      ["https://primary.example", primary],
    ]);
    const pool = makePool({
      STELLAR_HORIZON_URL: "https://primary.example",
      STELLAR_HORIZON_FALLBACK_URLS: "https://secondary.example",
    });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    await expect(
      proxy.execute((server) => server.submitTransaction({} as any)),
    ).rejects.toThrow("tx_failed");
    expect(secondary).not.toHaveBeenCalled();
    expect(proxy.getFailoverLog()).toEqual([]);
  });

  it("supports awaiting the recorded chain directly via target", async () => {
    const servers = new Map([
      ["https://primary.example", fakeServer({ hash: "TX" })],
    ]);
    const pool = makePool({ STELLAR_HORIZON_URL: "https://primary.example" });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    const record = await proxy.target.transactions().transaction("abc").call();
    expect(record).toEqual({ hash: "TX" });
  });

  it("surfaces HorizonRequestTimeoutError with node context", async () => {
    const servers = new Map([
      ["https://primary.example", fakeServer(undefined, { hangForever: true })],
    ]);
    const pool = makePool({
      STELLAR_HORIZON_URL: "https://primary.example",
      STELLAR_HORIZON_TIMEOUT_MS: "15",
    });
    const proxy = new ResilientHorizonProxy(
      pool,
      (url) => servers.get(url) as any,
    );

    await expect(
      proxy.execute((server) => server.transactions().transaction("h").call()),
    ).rejects.toBeInstanceOf(HorizonRequestTimeoutError);
  });
});
