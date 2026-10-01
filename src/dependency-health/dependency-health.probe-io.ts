/**
 * Node implementation of the I/O primitives a {@link DependencyProbeContext}
 * exposes.
 *
 * Shared by the in-process service (which hands over the live TypeORM
 * DataSource and Redis client when they exist) and by the maintainer CLI
 * (which has neither, and therefore falls back to TCP reachability probes).
 *
 * Every primitive is time-boxed so a wedged dependency can never make the
 * health report hang.
 *
 * Issue: #124
 */

import { Socket } from "net";
import { URL } from "url";
import {
  DependencyProbeContext,
  HttpProbeOutcome,
  JsonRpcProbeOutcome,
} from "./dependency-health.types";
import { resolveHostPort } from "./dependency-health.probe-kit";

export interface ProbeIoOptions {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  degradedLatencyMs: number;
  networkProbesEnabled: boolean;
  /** Live DataSource, when the process already has one. */
  dataSource?: { query: (sql: string) => Promise<unknown> };
  /** Live Redis client, when the process already has one. */
  redis?: { ping: () => Promise<string> } | null;
  now?: () => number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ProbeTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/** Rejects with {@link ProbeTimeoutError} if `promise` does not settle in time. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeoutError(label, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** TCP reachability probe. Resolves with the connect duration in ms. */
export function tcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();
  return new Promise<number>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(Date.now() - startedAt);
    };
    socket.setTimeout(timeoutMs, () =>
      finish(new ProbeTimeoutError(`tcp ${host}:${port}`, timeoutMs)),
    );
    socket.once("error", (error: Error) => finish(error));
    socket.connect(port, host, () => finish());
  });
}

function hostPortFromEnv(
  env: Record<string, string | undefined>,
  keys: string[],
  defaultPort: number,
): { host: string; port: number } {
  const value = keys.map((key) => env[key]).find((v) => v && v.trim() !== "");
  if (!value) {
    throw new Error(`invalid connection configuration: none of ${keys.join(", ")} is set`);
  }
  return resolveHostPort(value, defaultPort);
}

/** Builds a ready-to-use probe context. */
export function createProbeContext(options: ProbeIoOptions): DependencyProbeContext {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const env = options.env;

  const httpGet = async (
    url: string,
    timeoutMs: number,
  ): Promise<HttpProbeOutcome> => {
    if (!fetchImpl) {
      throw new Error("global fetch is unavailable on this runtime");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      return { status: response.status, latencyMs: now() - startedAt };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProbeTimeoutError(`GET ${url}`, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const jsonRpc = async (
    url: string,
    method: string,
    timeoutMs: number,
  ): Promise<JsonRpcProbeOutcome> => {
    if (!fetchImpl) {
      throw new Error("global fetch is unavailable on this runtime");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      });
      const latencyMs = now() - startedAt;
      const payload = (await response.json().catch(() => null)) as
        | { result?: unknown; error?: { message?: string } }
        | null;
      if (!payload) {
        return { latencyMs, error: `HTTP ${response.status} with a non-JSON body` };
      }
      if (payload.error) {
        return {
          latencyMs,
          error: payload.error.message ?? `HTTP ${response.status}`,
        };
      }
      return { latencyMs, result: payload.result };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProbeTimeoutError(`JSON-RPC ${method} ${url}`, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const query = async (
    system: "postgres" | "redis",
    timeoutMs: number,
  ): Promise<{ latencyMs: number }> => {
    if (system === "postgres" && options.dataSource) {
      const startedAt = now();
      await withTimeout(
        Promise.resolve(options.dataSource.query("SELECT 1")),
        timeoutMs,
        "database SELECT 1",
      );
      return { latencyMs: now() - startedAt };
    }
    if (system === "redis" && options.redis) {
      const startedAt = now();
      await withTimeout(
        Promise.resolve(options.redis.ping()),
        timeoutMs,
        "redis PING",
      );
      return { latencyMs: now() - startedAt };
    }
    // No live client: fall back to a reachability probe so the CLI and the
    // startup path still produce a meaningful verdict.
    const { host, port } =
      system === "postgres"
        ? hostPortFromEnv(env, ["DATABASE_URL"], 5432)
        : hostPortFromEnv(
            env,
            ["REDIS_URL", "REDIS_HOST"],
            Number(env.REDIS_PORT ?? 6379) || 6379,
          );
    return { latencyMs: await tcpConnect(host, port, timeoutMs) };
  };

  return {
    env,
    timeoutMs: options.timeoutMs,
    degradedLatencyMs: options.degradedLatencyMs,
    now,
    networkProbesEnabled: options.networkProbesEnabled,
    httpGet,
    jsonRpc,
    tcpConnect: (host, port, timeoutMs) => tcpConnect(host, port, timeoutMs),
    query,
  };
}

/**
 * Validates a URL without performing I/O. Used by the CLI to fail fast on a
 * malformed `DATABASE_URL` instead of reporting a confusing socket error.
 */
export function assertParsableUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`invalid url in ${label}`);
  }
}
