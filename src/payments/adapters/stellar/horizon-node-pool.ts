import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Default Horizon endpoint (primary node). */
export const DEFAULT_HORIZON_POOL_PRIMARY =
  "https://horizon-testnet.stellar.org";

/** Health state tracked per configured Horizon node. */
export interface HorizonNode {
  /** Horizon base URL, e.g. "https://horizon-testnet.stellar.org". */
  url: string;
  /** Whether the node is currently considered reachable. */
  healthy: boolean;
  /** Consecutive failures observed against this node. */
  consecutiveFailures: number;
  /** Epoch ms of the most recent failure (undefined when never failed). */
  lastFailureAt?: number;
}

/** Injectable knobs resolved from ConfigService (see env.validation.ts). */
export interface HorizonPoolConfig {
  nodes: HorizonNode[];
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  healthTtlMs: number;
}

/**
 * Ordered pool of Horizon RPC nodes with basic health tracking (issue #160).
 *
 * The first node is the primary (`STELLAR_HORIZON_URL`); the rest are the
 * comma-separated fallbacks from `STELLAR_HORIZON_FALLBACK_URLS`. A node that
 * records a failure is marked unhealthy and skipped for
 * `STELLAR_HORIZON_HEALTH_TTL_MS`, after which it is retried automatically —
 * so a node that was only briefly down recovers without a restart.
 *
 * If every node is unhealthy the primary is still returned so requests keep
 * flowing exactly as they did before pooling existed (degrade, don't die).
 */
export class HorizonNodePool {
  private readonly logger?: Logger;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly healthTtlMs: number;
  private nodes: HorizonNode[];
  private readonly now: () => number;

  constructor(
    config?: Pick<ConfigService, "get">,
    options?: { logger?: Logger; now?: () => number },
  ) {
    this.logger = options?.logger;
    this.now = options?.now ?? (() => Date.now());
    const get = (key: string, def: number): number => {
      const raw = config?.get<number | string>(key);
      const parsed = typeof raw === "string" ? parseInt(raw, 10) : raw;
      return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : def;
    };
    this.timeoutMs = get("STELLAR_HORIZON_TIMEOUT_MS", 5000);
    this.maxRetries = Math.max(1, get("STELLAR_HORIZON_MAX_RETRIES", 2));
    // Unlike the other knobs, 0 is a valid backoff base (retry immediately).
    const backoffRaw = config?.get<number | string>(
      "STELLAR_HORIZON_BACKOFF_BASE_MS",
    );
    const backoffParsed =
      typeof backoffRaw === "string" ? parseInt(backoffRaw, 10) : backoffRaw;
    this.backoffBaseMs =
      typeof backoffParsed === "number" &&
      Number.isFinite(backoffParsed) &&
      backoffParsed >= 0
        ? backoffParsed
        : 100;
    this.healthTtlMs = get("STELLAR_HORIZON_HEALTH_TTL_MS", 60000);

    const primary =
      (config?.get<string>("STELLAR_HORIZON_URL") || "").trim() ||
      DEFAULT_HORIZON_POOL_PRIMARY;
    const fallbacks = (
      config?.get<string>("STELLAR_HORIZON_FALLBACK_URLS") ?? ""
    )
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0 && url !== primary);

    this.nodes = [primary, ...fallbacks].map(
      (url): HorizonNode => ({ url, healthy: true, consecutiveFailures: 0 }),
    );
  }

  /** The configured primary endpoint. */
  get primaryUrl(): string {
    return this.nodes[0].url;
  }

  /** Read-only view of the nodes and their health (for tests and diagnostics). */
  getNodes(): readonly HorizonNode[] {
    return this.nodes;
  }

  /** Per-attempt request timeout in ms (issue #160 acceptance: >5s trips failover). */
  get timeout(): number {
    return this.timeoutMs;
  }

  /** Maximum number of attempts (across nodes) per request. */
  get maxAttempts(): number {
    return this.maxRetries;
  }

  /** Backoff base delay in ms; attempt N waits `base * 2^(N-1)` before retrying. */
  get backoffBase(): number {
    return this.backoffBaseMs;
  }

  /**
   * Candidate node URLs in priority order: healthy nodes first (primary
   * before fallbacks), then previously-failed nodes whose cooldown expired.
   * Nodes still inside their failure cooldown are skipped entirely.
   */
  getCandidateUrls(): string[] {
    const now = this.now();
    const eligible: HorizonNode[] = [];
    const cooling: HorizonNode[] = [];
    for (const node of this.nodes) {
      if (node.healthy || this.cooldownElapsed(node, now)) {
        eligible.push(node);
      } else {
        cooling.push(node);
      }
    }
    if (eligible.length === 0 && cooling.length > 0) {
      // Every node is inside its cooldown — prefer the primary rather than
      // dead-ending the request. Log once per call; this is rare.
      this.logger?.warn(
        "All Horizon nodes are in failure cooldown; falling back to the primary node.",
      );
      return [
        this.nodes[0].url,
        ...cooling.filter((n) => n !== this.nodes[0]).map((n) => n.url),
      ];
    }
    return eligible.map((node) => node.url);
  }

  /** Record a successful request against a node. */
  markSuccess(url: string): void {
    const node = this.nodes.find((n) => n.url === url);
    if (!node) return;
    node.consecutiveFailures = 0;
    node.lastFailureAt = undefined;
    node.healthy = true;
  }

  /** Record a failed request against a node and demote it to unhealthy. */
  markFailure(url: string): void {
    const node = this.nodes.find((n) => n.url === url);
    if (!node) return;
    node.consecutiveFailures += 1;
    node.lastFailureAt = this.now();
    node.healthy = false;
    this.logger?.warn(
      `Horizon node marked unhealthy after ${node.consecutiveFailures} consecutive failure(s): ${url}`,
    );
  }

  private cooldownElapsed(node: HorizonNode, now: number): boolean {
    return (
      node.lastFailureAt !== undefined &&
      now - node.lastFailureAt >= this.healthTtlMs
    );
  }
}

/**
 * Decide whether a Horizon error is worth retrying on another node.
 * Network-level faults, timeouts and transient HTTP statuses (429/5xx) are
 * transient; anything else (bad request, not found, failed transaction
 * result) is permanent for this request and must surface immediately.
 */
export function isTransientHorizonError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const anyErr = err as {
    code?: string | number;
    status?: number;
    response?: { status?: number; data?: unknown };
    message?: string;
    name?: string;
  };
  // Errors we raise ourselves on the timeout race are always transient.
  if (anyErr.name === "HorizonRequestTimeoutError") {
    return true;
  }
  const httpStatus =
    anyErr.response?.status ??
    anyErr.status ??
    (typeof anyErr.code === "number" ? anyErr.code : undefined);
  if (typeof httpStatus === "number") {
    return httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599);
  }
  const networkCodes = [
    "ECONNABORTED",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
  ];
  if (typeof anyErr.code === "string" && networkCodes.includes(anyErr.code)) {
    return true;
  }
  const message = anyErr.message ?? "";
  return /timeout|timed out|network error|socket hang up/i.test(message);
}
