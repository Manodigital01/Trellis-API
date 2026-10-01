/**
 * Sentinel node configuration for Redis Sentinel mode.
 */
export interface SentinelNodeConfig {
  host: string;
  port: number;
}

/**
 * Configuration interface for the cache module.
 *
 * All fields are optional — sensible defaults are applied in
 * {@link CacheModule}.
 */
export interface CacheConfig {
  /** Prefix prepended to every cache key. Default: "trellis:cache:". */
  prefix?: string;

  /** Default TTL in seconds for cache entries. Default: 300. */
  defaultTtlSeconds?: number;

  /** Maximum entries kept in the in-memory fallback cache. Default: 1000. */
  memoryMaxEntries?: number;

  /** Enable or disable hit/miss statistics tracking. Default: true. */
  enableStats?: boolean;

  /**
   * Enable stampede prevention (singleflight).
   * When true, concurrent requests for the same cache key are collapsed
   * into a single upstream call. Default: true.
   */
  enableStampedePrevention?: boolean;

  /** In-memory cache instance for fallback when Redis is unavailable. */
  memoryCache?: Map<string, { value: string; expiresAt: number }>;

  /** Redis Sentinel nodes for high-availability failover. If set, Sentinel mode is enabled. */
  sentinels?: SentinelNodeConfig[];

  /** Redis Sentinel service name (master name). Required when sentinels is set. */
  sentinelName?: string;

  /** Enable Redis Cluster mode (alternative to Sentinel). Requires cluster node endpoints. */
  enableCluster?: boolean;

  /** Redis Cluster nodes array when cluster mode is enabled. */
  clusterNodes?: Array<{ host: string; port: number }>;
}

/** Default configuration values. */
export const DEFAULT_CACHE_CONFIG: Required<
  Omit<
    CacheConfig,
    | "memoryCache"
    | "sentinels"
    | "sentinelName"
    | "enableCluster"
    | "clusterNodes"
  >
> & {
  memoryCache?: Map<string, { value: string; expiresAt: number }>;
  sentinels?: SentinelNodeConfig[];
  sentinelName?: string;
  enableCluster?: boolean;
  clusterNodes?: Array<{ host: string; port: number }>;
} = {
  prefix: "trellis:cache:",
  defaultTtlSeconds: 300,
  memoryMaxEntries: 1000,
  enableStats: true,
  enableStampedePrevention: true,
};
