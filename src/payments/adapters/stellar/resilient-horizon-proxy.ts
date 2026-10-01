import { Horizon } from "@stellar/stellar-sdk";
import { Logger } from "@nestjs/common";
import { HorizonNodePool, isTransientHorizonError } from "./horizon-node-pool";

/**
 * Error raised when a single Horizon attempt exceeds the configured per-attempt
 * timeout. Named so {@link isTransientHorizonError} can recognise it as
 * transient and the caller can fail over to the next node.
 */
export class HorizonRequestTimeoutError extends Error {
  readonly name = "HorizonRequestTimeoutError";
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Horizon request to ${url} timed out after ${timeoutMs}ms`);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One recorded call in a builder chain, e.g. `transactions()` or `.call()`. */
interface RecordedStep {
  prop: string;
  args: unknown[];
}

/** Marker step for the case where the proxy itself is invoked as a function. */
const CALL_STEP = "<call>";

/**
 * Replay a recorded call chain against a concrete `Horizon.Server`.
 *
 * Every step — including builder calls like `transactions()` and terminal I/O
 * like `.call()` — is re-executed on the given server, which is exactly what
 * failover needs: a retry must rebuild the request against the *next* node
 * instead of reusing a builder bound to the failed one.
 */
function applySteps(server: unknown, path: RecordedStep[]): unknown {
  let value: unknown = server;
  for (const step of path) {
    if (step.prop === CALL_STEP) {
      value = (value as (...args: unknown[]) => unknown)(...step.args);
      continue;
    }
    const member = (value as Record<string, unknown>)?.[step.prop];
    if (typeof member !== "function") {
      throw new Error(
        `ResilientHorizonProxy: "${step.prop}" is not a function on the Horizon server chain`,
      );
    }
    value = (member as (...args: unknown[]) => unknown).call(
      value,
      ...step.args,
    );
  }
  return value;
}

/**
 * Resilient Horizon RPC access (issue #160).
 *
 * {@link ResilientHorizonProxy.target} returns a drop-in replacement for
 * `Horizon.Server`: it records every builder-chain call made against it and
 * replays the chain behind the pool's retry policy —
 *
 * - per-attempt timeouts (`STELLAR_HORIZON_TIMEOUT_MS`, default 5s),
 * - ordered failover across nodes from {@link HorizonNodePool}, skipping
 *   nodes in failure cooldown,
 * - exponential backoff between attempts
 *   (`STELLAR_HORIZON_BACKOFF_BASE_MS`), and
 * - warn-level logging of every failover event so operators see node
 *   degradation without payment flows being interrupted.
 *
 * Only transient failures (timeouts, network errors, 429/5xx) are retried or
 * failed over; deterministic errors (bad request, failed transaction result)
 * propagate immediately. Callers keep their `Horizon.Server` typing and are
 * never aware a different node served a request.
 *
 * Limitation: only *method calls* are supported (which covers everything the
 * payments flow uses — `loadAccount`, `submitTransaction`, and the
 * `transactions()`/`payments()` builder chains). Non-function property reads
 * are not proxied.
 */
export class ResilientHorizonProxy {
  private readonly logger: Logger;
  private readonly servers: Map<string, Horizon.Server>;
  private readonly failoverEvents: string[] = [];

  constructor(
    private readonly pool: HorizonNodePool,
    private readonly serverFactory: (url: string) => Horizon.Server,
    logger?: Logger,
  ) {
    this.logger = logger ?? new Logger(ResilientHorizonProxy.name);
    this.servers = new Map();
    for (const node of pool.getNodes()) {
      this.servers.set(node.url, serverFactory(node.url));
    }
  }

  /**
   * A transparent stand-in for `Horizon.Server`. Await any chain built from it
   * and the recorded path is executed (with timeout, retry and failover)
   * against the best available node.
   */
  get target(): Horizon.Server {
    return this.makeChain([]);
  }

  /** Every failover event, formatted "from -> to" (for tests and diagnostics). */
  getFailoverLog(): readonly string[] {
    return this.failoverEvents;
  }

  /**
   * Run a single operation against the pool.
   *
   * Each node gets up to `STELLAR_HORIZON_MAX_RETRIES` attempts (retries use
   * exponential backoff: `base * 2^attempt`). When a node's retries are
   * exhausted the request fails over to the next candidate node, where the
   * retry budget starts afresh. Deterministic errors are never retried and
   * propagate immediately.
   */
  async execute<T>(op: (server: Horizon.Server) => Promise<T>): Promise<T> {
    const candidates = this.pool.getCandidateUrls();
    let lastError: unknown;

    for (let nodeIndex = 0; nodeIndex < candidates.length; nodeIndex += 1) {
      const url = candidates[nodeIndex];
      const server = this.servers.get(url);
      if (!server) {
        // Defensive: servers are built from the same pool, but skipping beats
        // crashing a payment flow if they ever diverge.
        continue;
      }

      for (let attempt = 0; attempt < this.pool.maxAttempts; attempt += 1) {
        try {
          const result = await this.withTimeout(op(server), url);
          this.pool.markSuccess(url);
          return result;
        } catch (err) {
          if (!isTransientHorizonError(err)) {
            throw err;
          }
          // Keep the earliest error: the primary's failure is the most
          // meaningful signal if every node ends up failing.
          lastError ??= err;
          this.pool.markFailure(url);
          this.logger.warn(
            `Horizon attempt ${attempt + 1}/${this.pool.maxAttempts} on ${url} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (attempt < this.pool.maxAttempts - 1) {
            await sleep(this.pool.backoffBase * 2 ** attempt);
          }
        }
      }

      // This node's retry budget is exhausted — fail over to the next one.
      const nextUrl = candidates[nodeIndex + 1];
      if (nextUrl) {
        this.failoverEvents.push(`${url} -> ${nextUrl}`);
        this.logger.warn(`Failing over Horizon RPC from ${url} to ${nextUrl}`);
      }
    }

    // Every node failed transiently. Prefer the earliest error — the primary's
    // failure is the most meaningful signal for the caller.
    throw lastError instanceof Error
      ? lastError
      : new Error(`All Horizon nodes failed: ${String(lastError)}`);
  }

  /**
   * Build a recording proxy node for `path`. Property access extends the
   * chain; awaiting the node (then/catch/finally) triggers execution of the
   * whole recorded path through {@link execute}.
   */
  private makeChain(path: RecordedStep[]): Horizon.Server {
    const proxy = function stub(): void {
      /* placeholder callable */
    } as unknown as Horizon.Server;
    return new Proxy(proxy, {
      get: (_t, prop: string | symbol) => {
        if (typeof prop === "symbol") {
          return undefined;
        }
        if (prop === "then") {
          return (
            onResolved: (v: unknown) => unknown,
            onRejected: (e: unknown) => unknown,
          ) =>
            this.execute(
              (server) => applySteps(server, path) as Promise<unknown>,
            ).then(onResolved, onRejected);
        }
        if (prop === "catch") {
          return (onRejected: (e: unknown) => unknown) =>
            this.execute(
              (server) => applySteps(server, path) as Promise<unknown>,
            ).catch(onRejected);
        }
        if (prop === "finally") {
          return (onFinally: () => void) =>
            this.execute(
              (server) => applySteps(server, path) as Promise<unknown>,
            ).finally(onFinally);
        }
        return (...args: unknown[]) =>
          this.makeChain([...path, { prop, args }]);
      },
      apply: (_t, _thisArg, args: unknown[]) => {
        return this.makeChain([...path, { prop: CALL_STEP, args }]);
      },
    });
  }

  /**
   * Race `promise` against the configured per-attempt timeout. A timeout
   * becomes {@link HorizonRequestTimeoutError} (transient) so the caller
   * fails over instead of hanging.
   */
  private async withTimeout<T>(promise: Promise<T>, url: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new HorizonRequestTimeoutError(url, this.pool.timeout)),
            this.pool.timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
