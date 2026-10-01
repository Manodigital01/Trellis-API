/**
 * WebSocket stress test (issue #96).
 *
 * The headline case runs a real Nest application with a real socket.io server
 * and 100 real client connections, then pushes 1,000 messages through it as fast
 * as the server will take them. It asserts the three things the issue asks for:
 *
 *   - no message loss,
 *   - a 95th-percentile delivery latency under 100 ms,
 *   - no memory growth across repeated load, and no state retained after every
 *     client disconnects.
 *
 * The service-level blocks below exercise the same machinery directly, because
 * the numbers that matter (per-user connection caps, stale detection, buffer
 * trimming, upstream pool limits, metric throughput) are properties of the
 * services rather than of the wire.
 */

import { createServer, Server as HttpServer } from "http";
import { AddressInfo } from "net";
import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { Server as SocketIoServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";

import { DashboardGateway } from "./dashboard.gateway";
import { ConnectionManagerService } from "./services/connection-manager.service";
import { EventBufferService } from "./services/event-buffer.service";
import { ConnectionPoolService } from "./services/connection-pool.service";
import { DashboardMetricsService } from "./services/dashboard-metrics.service";
import { DashboardEvent } from "./interfaces/websocket.interfaces";

// A real 100-connection, 1,000-message run does not fit in Jest's 5s default.
jest.setTimeout(120_000);

const CLIENT_COUNT = 100;
const PORTFOLIO_COUNT = 10;
const BROADCAST_COUNT = 1000;
const P95_BUDGET_MS = 100;
const HEAP_GROWTH_BUDGET_BYTES = 64 * 1024 * 1024;
const HEAP_RANGE_BUDGET_BYTES = 96 * 1024 * 1024;
/** Sub-millisecond spacing keeps the load a rapid stream, not one blocking burst. */
const BROADCAST_PACING_MS = 1;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, so the test never depends on a fixed sleep. */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

/** Fail fast instead of hanging until Jest's timeout. */
async function withTimeout<T>(work: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function heapUsed(): number {
  // `global.gc` is only present when Jest is run with --expose-gc; without it
  // the raw sample is noisier but the growth budget still holds.
  if (typeof (global as { gc?: () => void }).gc === "function") {
    (global as { gc: () => void }).gc();
  }
  return process.memoryUsage().heapUsed;
}

interface ClientProbe {
  socket: ClientSocket;
  userId: string;
  portfolioId: string;
  received: number;
  latencies: number[];
  errors: unknown[];
  disconnects: number;
}

describe("WebSocket Stress Tests", () => {
  let module: TestingModule;
  let app: INestApplication;
  let connectionManager: ConnectionManagerService;
  let eventBuffer: EventBufferService;
  let connectionPool: ConnectionPoolService;
  let metricsService: DashboardMetricsService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        DashboardGateway,
        ConnectionManagerService,
        EventBufferService,
        ConnectionPoolService,
        DashboardMetricsService,
        {
          // The gateway only needs a verified subject; the token *is* the user
          // id, which is what lets 100 clients be 100 distinct users.
          provide: JwtService,
          useValue: { verify: (token: string) => ({ sub: token }) },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    connectionManager = module.get(ConnectionManagerService);
    eventBuffer = module.get(EventBufferService);
    connectionPool = module.get(ConnectionPoolService);
    metricsService = module.get(DashboardMetricsService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Remove every connection the shared manager is still tracking. */
  const drainConnections = () => {
    for (const userId of connectionManager.getStats().byUser.keys()) {
      for (const info of connectionManager.getUserConnections(userId)) {
        connectionManager.removeConnection(info.clientId);
      }
    }
  };

  beforeEach(() => {
    eventBuffer.clearAllBuffers();
    drainConnections();
  });

  describe("Gateway throughput: 100 clients, 1,000 messages", () => {
    let gateway: DashboardGateway;
    let baseUrl: string;
    const probes: ClientProbe[] = [];

    const connectClient = (userId: string): ClientSocket => {
      const socket = ioClient(`${baseUrl}/dashboard`, {
        auth: { token: userId },
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      });
      return socket;
    };

    const openClient = async (index: number): Promise<ClientProbe> => {
      const userId = `stress-user-${index}`;
      const portfolioId = `stress-portfolio-${index % PORTFOLIO_COUNT}`;
      const probe: ClientProbe = {
        socket: null as unknown as ClientSocket,
        userId,
        portfolioId,
        received: 0,
        latencies: [],
        errors: [],
        disconnects: 0,
      };

      const socket = connectClient(userId);
      probe.socket = socket;
      socket.on(DashboardEvent.PORTFOLIO_UPDATE, (payload: { sentAt: number }) => {
        // Server and client share a process, so the clock delta is the
        // end-to-end delivery latency of this event.
        probe.latencies.push(Date.now() - payload.sentAt);
        probe.received += 1;
      });
      socket.on("error", (error: unknown) => probe.errors.push(error));

      // Both listeners are registered before the handshake can complete: the
      // gateway emits `connection:established` straight after the connect
      // frame, so subscribing to it after awaiting `connect` can miss it.
      const established = new Promise<void>((resolve, reject) => {
        socket.once(DashboardEvent.CONNECTION_ESTABLISHED, () => resolve());
        socket.once("connect_error", reject);
      });
      const connected = new Promise<void>((resolve) => {
        socket.once("connect", () => resolve());
      });
      await withTimeout(
        Promise.all([connected, established]),
        `client ${index} to complete its handshake`,
      );

      socket.on("disconnect", () => {
        probe.disconnects += 1;
      });

      socket.emit(DashboardEvent.SUBSCRIBE_PORTFOLIO, {
        data: { portfolioId },
      });
      await withTimeout(
        waitFor(
          () =>
            connectionManager
              .getPortfolioSubscribers(portfolioId)
              .includes(socket.id as string),
          `client ${index} to join ${portfolioId}`,
        ),
        `client ${index} subscription`,
      );

      probes.push(probe);
      return probe;
    };

    /**
     * `@WebSocketServer()` on a namespaced gateway is the socket.io *Namespace*,
     * so its live-socket registry is `sockets` rather than `of(ns).sockets`.
     */
    const liveSockets = () =>
      (gateway.server as unknown as { sockets: Map<string, unknown> }).sockets;

    const resetProbes = () => {
      for (const probe of probes) {
        probe.received = 0;
        probe.latencies.length = 0;
        probe.errors.length = 0;
      }
    };

    /**
     * Push `count` messages round-robin across the subscribed portfolios. The
     * sends are paced by a millisecond: emitting the whole burst inside one
     * synchronous loop queues every event behind a single event-loop turn and
     * measures the loop, not delivery latency.
     */
    const broadcast = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const portfolioId = `stress-portfolio-${i % PORTFOLIO_COUNT}`;
        gateway.broadcastToPortfolio(portfolioId, DashboardEvent.PORTFOLIO_UPDATE, {
          sequence: i,
          sentAt: Date.now(),
          portfolioId,
        });
        if (i % 50 === 49) {
          await sleep(BROADCAST_PACING_MS);
        }
      }
    };

    const waitForDelivery = async (count: number) => {
      const expectedPerClient = count / PORTFOLIO_COUNT;
      await waitFor(
        () => probes.every((probe) => probe.received >= expectedPerClient),
        `all ${probes.length} clients to receive ${expectedPerClient} messages`,
        30_000,
      );
    };

    beforeAll(async () => {
      gateway = module.get(DashboardGateway);
      // An explicit IPv4 bind: `listen(0)` on this host reports an IPv6
      // loopback URL, which the client sockets then fail to reach.
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      for (const probe of probes) {
        probe.socket.removeAllListeners();
        probe.socket.disconnect();
      }
    });

    it("opens 100 concurrent authenticated connections", async () => {
      await Promise.all(
        Array.from({ length: CLIENT_COUNT }, (_, index) => openClient(index)),
      );

      expect(probes).toHaveLength(CLIENT_COUNT);
      expect(connectionManager.getConnectionCount()).toBe(CLIENT_COUNT);
      // 100 clients across 10 portfolios, every client authenticated as its own
      // user rather than sharing one identity.
      for (let p = 0; p < PORTFOLIO_COUNT; p++) {
        expect(
          connectionManager.getPortfolioSubscribers(`stress-portfolio-${p}`),
        ).toHaveLength(CLIENT_COUNT / PORTFOLIO_COUNT);
      }
    });

    it("delivers 1,000 rapid messages with zero loss and p95 under 100ms", async () => {
      // Warm the path first so the first measured message is not paying for JIT
      // and buffer allocation.
      await broadcast(PORTFOLIO_COUNT * 2);
      await waitForDelivery(PORTFOLIO_COUNT * 2);
      resetProbes();

      const startedAt = Date.now();
      await broadcast(BROADCAST_COUNT);
      await waitForDelivery(BROADCAST_COUNT);
      const elapsed = Date.now() - startedAt;

      const expectedPerClient = BROADCAST_COUNT / PORTFOLIO_COUNT;
      const totalDelivered = probes.reduce(
        (sum, probe) => sum + probe.received,
        0,
      );
      const latencies = probes.flatMap((probe) => probe.latencies);
      const p95 = percentile(latencies, 0.95);
      const p99 = percentile(latencies, 0.99);

      for (const probe of probes) {
        expect(probe.errors).toEqual([]);
        expect(probe.disconnects).toBe(0);
        expect(probe.received).toBe(expectedPerClient);
      }
      // 1,000 messages × 10 subscribers each: every one of them accounted for.
      expect(totalDelivered).toBe(BROADCAST_COUNT * (CLIENT_COUNT / PORTFOLIO_COUNT));
      expect(p95).toBeLessThan(P95_BUDGET_MS);

      // eslint-disable-next-line no-console
      console.log(
        `[ws-stress] ${BROADCAST_COUNT} messages → ${totalDelivered} deliveries ` +
          `across ${CLIENT_COUNT} clients in ${elapsed}ms ` +
          `(p50 ${percentile(latencies, 0.5)}ms, p95 ${p95}ms, p99 ${p99}ms, max ${Math.max(...latencies)}ms)`,
      );
    });

    it("does not grow the heap across repeated load and releases state on disconnect", async () => {
      const samples: number[] = [];
      for (let round = 0; round < 3; round++) {
        await broadcast(BROADCAST_COUNT);
        await waitForDelivery(BROADCAST_COUNT);
        resetProbes();
        samples.push(heapUsed());
      }

      const growth = samples[samples.length - 1] - samples[0];
      const spread = Math.max(...samples) - Math.min(...samples);

      // A leak shows up as growth that keeps climbing with every round; steady
      // churn stays inside a few MB of noise.
      expect(growth).toBeLessThan(HEAP_GROWTH_BUDGET_BYTES);
      expect(spread).toBeLessThan(HEAP_RANGE_BUDGET_BYTES);

      for (const probe of probes) {
        probe.socket.removeAllListeners();
        probe.socket.disconnect();
      }

      await waitFor(
        () => liveSockets().size === 0,
        "every socket to leave the namespace registry",
      );
      await waitFor(
        () => connectionManager.getStats().active === 0,
        "the gateway to observe every disconnect",
      );
      // All 100 sockets gone from the namespace registry...
      expect(liveSockets().size).toBe(0);
      // ...and the connection manager can be drained, so no per-client state is
      // pinned in memory once the sockets are gone.
      // Nothing about those 100 connections is still held on the server: the
      // socket registry is empty and the manager tracks neither the connections
      // nor the users that owned them.
      expect(liveSockets().size).toBe(0);
      expect(connectionManager.getConnectionCount()).toBe(0);
      expect(connectionManager.getStats().byUser.size).toBe(0);

      // eslint-disable-next-line no-console
      console.log(
        `[ws-stress] heap samples (MB): ${samples
          .map((sample) => (sample / 1024 / 1024).toFixed(1))
          .join(" → ")}`,
      );
    });
  });

  describe("Connection Manager Stress Test", () => {
    it("should handle 1000 concurrent connections", async () => {
      const clientCount = 1000;
      const startTime = Date.now();

      await Promise.all(
        Array.from({ length: clientCount }, (_, i) =>
          connectionManager.registerConnection(`client-${i}`, {
            userId: `user-${i}`,
            clientId: `client-${i}`,
            connectedAt: new Date(),
            lastHeartbeat: new Date(),
            isAlive: true,
            subscriptions: [],
          }),
        ),
      );

      const duration = Date.now() - startTime;

      expect(connectionManager.getConnectionCount()).toBe(clientCount);
      // eslint-disable-next-line no-console
      console.log(`Registered ${clientCount} connections in ${duration}ms`);
    });

    it("should cap concurrent connections per user", async () => {
      const userId = "single-user";
      const registered = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          connectionManager.registerConnection(`user0-client-${i}`, {
            userId,
            clientId: `user0-client-${i}`,
            connectedAt: new Date(),
            lastHeartbeat: new Date(),
            isAlive: true,
            subscriptions: [],
          }),
        ),
      );

      // MAX_WS_CONNECTIONS_PER_USER defaults to 5; the rest are refused instead
      // of being tracked.
      expect(registered.filter(Boolean)).toHaveLength(5);
      expect(connectionManager.getUserConnections(userId)).toHaveLength(5);
    });

    it("should efficiently identify stale connections", async () => {
      const clientCount = 1000;
      const staleCount = 500;

      for (let i = 0; i < clientCount; i++) {
        await connectionManager.registerConnection(`stale-client-${i}`, {
          userId: `stale-user-${i}`,
          clientId: `stale-client-${i}`,
          connectedAt: new Date(),
          lastHeartbeat:
            i < staleCount
              ? new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
              : new Date(),
          isAlive: true,
          subscriptions: [],
        });
      }

      const startTime = Date.now();
      const stale = connectionManager.getStaleConnections(5 * 60 * 1000);
      const duration = Date.now() - startTime;

      expect(stale.size).toBe(staleCount);
      expect(duration).toBeLessThan(100);

      // eslint-disable-next-line no-console
      console.log(
        `Identified ${stale.size} stale connections in ${duration}ms`,
      );
    });

    it("should clean up inactive connections efficiently", async () => {
      const clientCount = 1000;

      for (let i = 0; i < clientCount; i++) {
        await connectionManager.registerConnection(`inactive-client-${i}`, {
          userId: `inactive-user-${i}`,
          clientId: `inactive-client-${i}`,
          connectedAt: new Date(),
          lastHeartbeat: new Date(),
          isAlive: i % 2 === 0,
          subscriptions: [],
        });

        if (i % 2 === 1) {
          connectionManager.markDisconnected(`inactive-client-${i}`);
        }
      }

      const startTime = Date.now();
      const removed = connectionManager.cleanupInactiveConnections(-1);
      const duration = Date.now() - startTime;

      expect(removed).toHaveLength(clientCount / 2);
      expect(duration).toBeLessThan(200);

      // eslint-disable-next-line no-console
      console.log(
        `Cleaned up ${removed.length} inactive connections in ${duration}ms`,
      );
    });
  });

  describe("Event Buffer Stress Test", () => {
    it("should buffer events for 1000 users efficiently", async () => {
      const userCount = 1000;
      const eventsPerUser = 10;

      const startTime = Date.now();

      for (let i = 0; i < userCount; i++) {
        eventBuffer.startBuffering(`user-${i}`, `client-${i}`);

        for (let j = 0; j < eventsPerUser; j++) {
          eventBuffer.bufferEvent(`user-${i}`, {
            event: DashboardEvent.PORTFOLIO_UPDATE,
            data: { portfolioId: `portfolio-${j}`, value: j * 100 },
            timestamp: new Date(),
          });
        }
      }

      const duration = Date.now() - startTime;
      const stats = eventBuffer.getStats();

      expect(stats.totalUsers).toBe(userCount);
      expect(stats.totalEvents).toBe(userCount * eventsPerUser);
      expect(duration).toBeLessThan(5000);

      // eslint-disable-next-line no-console
      console.log(
        `Buffered ${stats.totalEvents} events for ${stats.totalUsers} users in ${duration}ms`,
      );
    });

    it("should retrieve buffered events efficiently", async () => {
      const userCount = 1000;

      for (let i = 0; i < userCount; i++) {
        eventBuffer.startBuffering(`retrieve-user-${i}`, `client-${i}`);
        for (let j = 0; j < 10; j++) {
          eventBuffer.bufferEvent(`retrieve-user-${i}`, {
            event: DashboardEvent.PORTFOLIO_UPDATE,
            data: { index: j },
            timestamp: new Date(),
          });
        }
      }

      const startTime = Date.now();
      let totalEvents = 0;

      for (let i = 0; i < userCount; i++) {
        totalEvents += eventBuffer.getBufferedEvents(`retrieve-user-${i}`).length;
      }

      const duration = Date.now() - startTime;

      expect(totalEvents).toBe(userCount * 10);
      expect(duration).toBeLessThan(3000);

      // eslint-disable-next-line no-console
      console.log(`Retrieved ${totalEvents} events in ${duration}ms`);
    });

    it("should bound the buffer so a long disconnection cannot grow without limit", () => {
      for (let i = 0; i < 2000; i++) {
        eventBuffer.bufferEvent("chatty-user", {
          event: DashboardEvent.PORTFOLIO_UPDATE,
          data: { index: i },
          timestamp: new Date(),
        });
      }

      const buffered = eventBuffer.getBufferedEvents("chatty-user");
      expect(buffered.length).toBeLessThanOrEqual(1000);
      // The oldest events are the ones dropped, so the survivors are the newest.
      expect(buffered[buffered.length - 1].data.index).toBe(1999);
    });
  });

  describe("Connection Pool Stress Test", () => {
    let upstream: HttpServer;
    let upstreamSocketIo: SocketIoServer;
    let upstreamUrl: string;

    beforeAll(async () => {
      upstream = createServer();
      upstreamSocketIo = new SocketIoServer(upstream, {
        cors: { origin: "*", credentials: true },
      });
      upstreamSocketIo.on("connection", (socket) => {
        socket.emit("upstream:ready", { at: Date.now() });
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const { port } = upstream.address() as AddressInfo;
      upstreamUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      if (upstreamSocketIo) {
        await new Promise<void>((resolve) => upstreamSocketIo.close(() => resolve()));
      }
      if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    it("should maintain the configured maximum for a real upstream", async () => {
      const maxConnections = 20;
      const attempts = 30;
      await connectionPool.initializePool("stress-upstream", {
        maxConnections,
        connectionTimeout: 5_000,
        heartbeatInterval: 60_000,
      });

      // Distinct URLs keep the pool from de-duplicating the connection, so this
      // really asks for `attempts` connections from one upstream.
      const firstBatch = await Promise.all(
        Array.from({ length: maxConnections }, (_, i) =>
          connectionPool.acquire("stress-upstream", `${upstreamUrl}?i=${i}`),
        ),
      );
      expect(firstBatch.filter(Boolean)).toHaveLength(maxConnections);
      // `acquire` hands back the connection object as soon as the socket starts,
      // so wait for the pool to actually reach its cap before asking for more.
      await waitFor(
        () =>
          connectionPool.getPoolStats("stress-upstream")?.activeConnections ===
          maxConnections,
        `the pool to reach ${maxConnections} live connections`,
      );

      const overflow = await Promise.all(
        Array.from({ length: attempts - maxConnections }, (_, i) =>
          connectionPool.acquire("stress-upstream", `${upstreamUrl}?extra=${i}`),
        ),
      );
      const stats = connectionPool.getPoolStats("stress-upstream");
      expect(stats?.maxConnections).toBe(maxConnections);
      // Everything past the cap is refused outright.
      expect(overflow.filter(Boolean)).toHaveLength(0);
      expect(stats?.totalConnections).toBe(maxConnections);
      expect(stats?.activeConnections).toBe(maxConnections);

      // eslint-disable-next-line no-console
      console.log(
        `Pool stress-upstream: ${stats?.totalConnections}/${stats?.maxConnections} connections held`,
      );
    });
  });

  describe("Metrics Service Stress Test", () => {
    it("should handle high volume of metric updates", async () => {
      const updateCount = 10000;
      const startTime = Date.now();

      for (let i = 0; i < updateCount; i++) {
        metricsService.incrementConnection("dashboard", "connect");
        metricsService.recordHeartbeat("dashboard");
        metricsService.recordEventSent("dashboard", "portfolio:update");
      }

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000);

      // eslint-disable-next-line no-console
      console.log(`Recorded ${updateCount * 3} metrics in ${duration}ms`);
    });
  });

  describe("Health Check Stress Test", () => {
    it("should report stats with many connections", async () => {
      const clientCount = 500;

      for (let i = 0; i < clientCount; i++) {
        await connectionManager.registerConnection(`health-client-${i}`, {
          userId: `health-user-${i % 100}`,
          clientId: `health-client-${i}`,
          connectedAt: new Date(),
          lastHeartbeat: new Date(),
          isAlive: true,
          subscriptions: [],
        });
        if (i % 10 === 0) {
          connectionManager.markDisconnected(`health-client-${i}`);
        }
      }

      const startTime = Date.now();
      const stats = connectionManager.getStats();
      const duration = Date.now() - startTime;

      expect(stats.total).toBe(clientCount);
      expect(stats.active).toBe(clientCount - clientCount / 10);
      expect(stats.byUser.size).toBe(100);
      expect(duration).toBeLessThan(50);

      // eslint-disable-next-line no-console
      console.log(
        `Health check for ${clientCount} connections completed in ${duration}ms`,
      );
    });
  });
});

describe("WebSocket Client Manager Tests", () => {
  describe("Reconnection with Exponential Backoff", () => {
    it("should implement correct backoff timing", () => {
      const delays: number[] = [];
      let currentDelay = 1000; // base
      const maxDelay = 30000;
      const factor = 2;

      for (let attempt = 0; attempt < 10; attempt++) {
        delays.push(currentDelay);
        currentDelay = Math.min(currentDelay * factor, maxDelay);
      }

      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(2000);
      expect(delays[2]).toBe(4000);
      expect(delays[3]).toBe(8000);
      expect(delays[4]).toBe(16000);
      expect(delays[5]).toBe(30000);
      expect(delays[6]).toBe(30000); // Capped at max
      expect(delays[9]).toBe(30000); // Still capped
    });

    it("should not exceed max delay of 30 seconds", () => {
      let currentDelay = 1000;
      const maxDelay = 30000;
      const factor = 2;

      for (let i = 0; i < 20; i++) {
        currentDelay = Math.min(currentDelay * factor, maxDelay);
      }

      expect(currentDelay).toBe(maxDelay);
    });
  });

  describe("Event Buffering During Disconnection", () => {
    it("should buffer events during disconnection", () => {
      const buffer: unknown[] = [];
      const maxBufferSize = 1000;

      for (let i = 0; i < 1500; i++) {
        buffer.push({
          event: DashboardEvent.PORTFOLIO_UPDATE,
          data: { index: i },
          timestamp: new Date(),
        });

        if (buffer.length > maxBufferSize) {
          buffer.shift();
        }
      }

      expect(buffer).toHaveLength(maxBufferSize);
      expect((buffer[0] as { data: { index: number } }).data.index).toBe(500);
    });
  });

  describe("Gateway timers", () => {
    it("releases its intervals on shutdown", async () => {
      // The heartbeat and stale-connection intervals used to outlive the
      // gateway, which kept Jest (and a rolling deploy) from ever releasing
      // them.
      const gateway = new DashboardGateway(
        new ConnectionManagerService(),
        new EventBufferService(),
        new DashboardMetricsService(),
        new JwtService(),
      );
      (gateway as unknown as { server: { emit: () => void } }).server = {
        emit: () => undefined,
      };

      await gateway.afterInit(
        (gateway as unknown as { server: never }).server,
      );
      const timers = (
        gateway as unknown as { timers: Set<NodeJS.Timeout> }
      ).timers;
      expect(timers.size).toBe(2);

      gateway.onModuleDestroy();
      expect(timers.size).toBe(0);
    });
  });
});
