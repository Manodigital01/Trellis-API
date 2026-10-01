import Redis, { Cluster, type SentinelConnector } from "ioredis";
import { logger } from "../../config/logger";

interface RedisFactoryOptions {
  sentinels?: Array<{ host: string; port: number }>;
  sentinelName?: string;
  enableCluster?: boolean;
  clusterNodes?: Array<{ host: string; port: number }>;
}

/**
 * Common Redis client options for all connection modes.
 */
function getDefaultOptions(label: string) {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 10) {
        logger.warn(
          { times, label },
          "Redis reconnection giving up after 10 attempts",
        );
        return null;
      }
      const delay = Math.min(times * 200, 5000);
      logger.debug({ times, delay, label }, "Redis reconnecting after delay");
      return delay;
    },
    reconnectOnError(err: Error) {
      const targetErrors = [
        "READONLY",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
      ];
      const shouldReconnect = targetErrors.some((e) =>
        err.message.includes(e),
      );
      if (shouldReconnect) {
        logger.warn(
          { error: err.message, label },
          "Redis reconnecting on recoverable error",
        );
      }
      return shouldReconnect;
    },
    connectTimeout: 10_000,
    enableReadyCheck: true,
    autoResubscribe: true,
    autoResendUnfulfilledCommands: true,
    keepAlive: 30_000,
    enableOfflineQueue: true,
  };
}

/**
 * Attach standard event handlers to a Redis client.
 */
function attachEventHandlers(
  client: Redis | Cluster,
  label: string,
): void {
  client.on("connect", () => {
    logger.info({ label }, "Redis client connected");
  });

  client.on("ready", () => {
    logger.info({ label }, "Redis client ready");
  });

  client.on("error", (err: Error) => {
    logger.error({ error: err.message, label }, "Redis client error");
  });

  client.on("close", () => {
    logger.warn({ label }, "Redis client connection closed");
  });

  client.on("reconnecting", (delay?: number) => {
    logger.info({ delay, label }, "Redis client reconnecting");
  });
}

/**
 * Create a Redis client with Sentinel support for high-availability failover.
 */
function createSentinelClient(
  sentinels: Array<{ host: string; port: number }>,
  sentinelName: string,
  label: string,
): Redis {
  const client = new Redis({
    ...getDefaultOptions(label),
    sentinels,
    name: sentinelName,
    sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD,
    password: process.env.REDIS_PASSWORD,
  });

  attachEventHandlers(client, label);
  return client;
}

/**
 * Create a Redis Cluster client for distributed caching.
 */
function createClusterClient(
  clusterNodes: Array<{ host: string; port: number }>,
  label: string,
): Cluster {
  const client = new Cluster(clusterNodes, {
    ...getDefaultOptions(label),
    redisOptions: {
      password: process.env.REDIS_PASSWORD,
    },
    dnsLookup: (address: string, callback: Function) => {
      // Use DNS resolution for better reliability
      require("dns").lookup(address, callback);
    },
  });

  attachEventHandlers(client, label);
  return client;
}

/**
 * Create an ioredis client with sensible defaults for caching.
 *
 * Features:
 * - Standalone mode (default): Single Redis node
 * - Sentinel mode: High-availability failover with multiple sentinels
 * - Cluster mode: Distributed caching with automatic node discovery
 * - Automatic reconnection with exponential backoff
 * - Configurable connection timeout
 * - Graceful error logging
 *
 * @param redisUrl  Full Redis URL for standalone mode (e.g. "redis://localhost:6379")
 * @param options   Optional configuration for Sentinel or Cluster modes
 * @param label     Human-readable label for log messages
 * @returns A connected ioredis instance
 */
export function createRedisClient(
  redisUrl: string,
  options: RedisFactoryOptions = {},
  label = "cache",
): Redis | Cluster {
  // Sentinel mode
  if (options.sentinels && options.sentinelName) {
    logger.info(
      { sentinelCount: options.sentinels.length, sentinelName: options.sentinelName, label },
      "Creating Redis Sentinel client",
    );
    return createSentinelClient(options.sentinels, options.sentinelName, label);
  }

  // Cluster mode
  if (options.enableCluster && options.clusterNodes && options.clusterNodes.length > 0) {
    logger.info(
      { clusterNodeCount: options.clusterNodes.length, label },
      "Creating Redis Cluster client",
    );
    return createClusterClient(options.clusterNodes, label);
  }

  // Standalone mode (default)
  logger.debug({ redisUrl, label }, "Creating standalone Redis client");
  const client = new Redis(redisUrl, getDefaultOptions(label));
  attachEventHandlers(client, label);
  return client;
}
