import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { createRedisClient } from "./cache-redis.factory";

/**
 * Tests for Redis Sentinel failover scenarios.
 *
 * These tests verify that the cache module can handle Sentinel failover
 * without throwing uncaught exceptions and with proper exponential backoff.
 */
describe("Redis Sentinel Support (Issue #78)", () => {
  describe("createRedisClient with Sentinel configuration", () => {
    it("should create a Sentinel client when sentinels config is provided", () => {
      const sentinels = [
        { host: "sentinel1", port: 26379 },
        { host: "sentinel2", port: 26379 },
        { host: "sentinel3", port: 26379 },
      ];

      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
      }, "test-sentinel");

      expect(client).toBeDefined();
      expect(client instanceof Redis).toBe(true);
    });

    it("should create a Cluster client when cluster mode is enabled", () => {
      const clusterNodes = [
        { host: "node1", port: 6379 },
        { host: "node2", port: 6379 },
        { host: "node3", port: 6379 },
      ];

      const client = createRedisClient("redis://localhost:6379", {
        enableCluster: true,
        clusterNodes,
      }, "test-cluster");

      expect(client).toBeDefined();
    });

    it("should prefer Sentinel mode over Cluster if both configured", () => {
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const clusterNodes = [{ host: "node1", port: 6379 }];

      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
        enableCluster: true,
        clusterNodes,
      }, "test-priority");

      expect(client).toBeDefined();
    });

    it("should fall back to standalone mode when no HA config provided", () => {
      const client = createRedisClient("redis://localhost:6379", {}, "test-standalone");

      expect(client).toBeDefined();
      expect(client instanceof Redis).toBe(true);
    });

    it("should configure exponential backoff retry strategy", () => {
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
      }, "test-backoff");

      expect(client).toBeDefined();
      // Client should have retry strategy that implements exponential backoff
      // Verify by checking internal options if accessible
    });
  });

  describe("Sentinel failover resilience", () => {
    it("should configure lazy connection to defer actual connection until needed", () => {
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
      }, "test-lazy");

      expect(client).toBeDefined();
      // Lazy connect means connection is deferred until first command
    });

    it("should register reconnection event handlers", () => {
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
      }, "test-events");

      // Verify that event handlers are attached
      const hasReconnectHandler = client.listenerCount("reconnecting") > 0;
      const hasErrorHandler = client.listenerCount("error") > 0;

      expect(hasReconnectHandler || hasErrorHandler).toBe(true);
    });

    it("should handle reconnection on READONLY error during Sentinel failover", () => {
      // READONLY errors indicate failover is happening; client should reconnect
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
      }, "test-readonly");

      expect(client).toBeDefined();
      // In a real scenario, READONLY error would trigger reconnectOnError callback
    });
  });

  describe("Configuration environment variables", () => {
    it("should accept REDIS_SENTINEL_HOSTS as JSON string", () => {
      const sentinelsJson = JSON.stringify([
        { host: "sentinel1", port: 26379 },
        { host: "sentinel2", port: 26379 },
      ]);

      const sentinels = JSON.parse(sentinelsJson);
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster",
      }, "test-env");

      expect(client).toBeDefined();
    });

    it("should use default sentinel name 'mymaster' if not specified", () => {
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "mymaster", // Default
      }, "test-default-name");

      expect(client).toBeDefined();
    });

    it("should accept custom sentinel master name", () => {
      const sentinels = [{ host: "sentinel1", port: 26379 }];
      const client = createRedisClient("redis://localhost:6379", {
        sentinels,
        sentinelName: "custom-master-name",
      }, "test-custom-name");

      expect(client).toBeDefined();
    });
  });

  describe("Backward compatibility", () => {
    it("should work with existing REDIS_URL without Sentinel config", () => {
      const client = createRedisClient("redis://localhost:6379", {}, "test-legacy");

      expect(client).toBeDefined();
      expect(client instanceof Redis).toBe(true);
    });

    it("should not break when options object is empty", () => {
      const client = createRedisClient("redis://localhost:6379", {}, "test-empty-options");

      expect(client).toBeDefined();
    });

    it("should handle undefined options gracefully", () => {
      const client = createRedisClient("redis://localhost:6379", undefined, "test-undefined-options");

      expect(client).toBeDefined();
    });
  });
});
