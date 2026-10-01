import {
  calculateLatencyStats,
  categorizeError,
  categorizeStatusCode,
  getDailySalt,
  getPrivacyBoundarySpecification,
  hashActorId,
  normalizeRoute,
  SAFE_DIMENSIONS,
  sanitizeTelemetryEvent,
  scrubSensitiveFields,
  SENSITIVE_FIELD_NAMES,
} from "./privacy/privacy-boundary.definition";
import { MaintainerInsightsService } from "./maintainer-insights.service";
import { MaintainerInsightsController } from "./maintainer-insights.controller";
import { MetricGranularity } from "./dto/maintainer-insights.dto";

describe("Privacy-Preserving Maintainer Insights", () => {
  // ---------------------------------------------------------------------------
  // 1. Privacy Boundary Invariants
  // ---------------------------------------------------------------------------
  describe("Privacy Boundary & Sanitization Invariants", () => {
    it("should define safe dimensions and list forbidden sensitive fields", () => {
      const spec = getPrivacyBoundarySpecification();
      expect(spec.version).toBe("1.0.0");
      expect(spec.safeDimensions).toEqual(SAFE_DIMENSIONS);
      expect(spec.forbiddenFields.length).toBeGreaterThan(20);
      expect(spec.forbiddenFields).toContain("password");
      expect(spec.forbiddenFields).toContain("token");
      expect(spec.forbiddenFields).toContain("secret");
      expect(spec.forbiddenFields).toContain("apikey");
      expect(spec.forbiddenFields).toContain("privatekey");
      expect(spec.forbiddenFields).toContain("walletaddress");
      expect(spec.retention.hourlyAggregatesDays).toBe(30);
      expect(spec.retention.dailyAggregatesDays).toBe(365);
    });

    it("should normalize routes to collapse high-cardinality and sensitive path parameters", () => {
      // UUID normalization
      expect(
        normalizeRoute("/api/v1/portfolios/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/assets"),
      ).toBe("/api/v1/portfolios/:uuid/assets");

      // Stellar public address normalization (56 chars starting with G)
      expect(
        normalizeRoute(
          "/api/v1/wallets/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN/balance",
        ),
      ).toBe("/api/v1/wallets/:stellarAddress/balance");

      // Ethereum address normalization
      expect(
        normalizeRoute("/api/v1/defi/0x1234567890123456789012345678901234567890/positions"),
      ).toBe("/api/v1/defi/:ethAddress/positions");

      // 64-char transaction hash normalization
      expect(
        normalizeRoute(
          "/api/v1/reconcile/tx/9cc3bcab9450390ce5e214045a41e70e6d4a920f2bbc3e5d873c90eadfb7e45c",
        ),
      ).toBe("/api/v1/reconcile/tx/:txHash");

      // Numeric ID normalization
      expect(normalizeRoute("/api/v1/users/4215/profile")).toBe("/api/v1/users/:id/profile");

      // Query parameter stripping
      expect(normalizeRoute("/api/v1/oracle/payloads?token=secret123&page=1")).toBe(
        "/api/v1/oracle/payloads",
      );
    });

    it("should correctly categorize HTTP status codes", () => {
      expect(categorizeStatusCode(200)).toBe("2xx");
      expect(categorizeStatusCode(201)).toBe("2xx");
      expect(categorizeStatusCode(204)).toBe("2xx");
      expect(categorizeStatusCode(400)).toBe("4xx");
      expect(categorizeStatusCode(401)).toBe("4xx");
      expect(categorizeStatusCode(404)).toBe("4xx");
      expect(categorizeStatusCode(429)).toBe("4xx");
      expect(categorizeStatusCode(500)).toBe("5xx");
      expect(categorizeStatusCode(503)).toBe("5xx");
      expect(categorizeStatusCode(101)).toBe("other");
    });

    it("should categorize errors without storing raw error messages or sensitive payload details", () => {
      expect(categorizeError(200)).toBe("NONE");
      expect(
        categorizeError(429, "RATE_LIMIT_EXCEEDED", "Too many requests from IP 1.2.3.4"),
      ).toBe("RATE_LIMITED");
      expect(
        categorizeError(401, "UNAUTHORIZED", "Invalid token eyJhbGciOi..."),
      ).toBe("AUTHENTICATION_FAILED");
      expect(
        categorizeError(403, "FORBIDDEN", "User u-123 failed KYC checks"),
      ).toBe("AUTHORIZATION_DENIED");
      expect(
        categorizeError(400, "VALIDATION_FAILED", "Field balance must be positive"),
      ).toBe("VALIDATION_ERROR");
      expect(
        categorizeError(400, "ORACLE_DRIFT_EXCEEDED", "Feed XLM/USD price drift 5.2%"),
      ).toBe("ORACLE_DRIFT");
      expect(
        categorizeError(500, "DATABASE_ERROR", "Connection refused to db.internal"),
      ).toBe("INTERNAL_ERROR");
      expect(
        categorizeError(503, "GATEWAY_TIMEOUT", "Stellar horizon timeout"),
      ).toBe("EXTERNAL_GATEWAY_ERROR");
    });

    it("should never export raw actor identifiers, tokens, secrets, or payloads in sanitized event", () => {
      const rawSecretUser = "usr_998877665544";
      const rawSecretWallet = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const rawSecretToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret";
      const rawPrivateKey = "SBCW2ACURUSJJXAX6JUSKNA7D7H7UJJJAXD";

      const sanitized = sanitizeTelemetryEvent({
        operation: "portfolio.rebalance",
        route: `/api/v1/portfolios/9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4/rebalance`,
        statusCode: 200,
        latencyMs: 145.8,
        actorId: rawSecretUser,
        actorType: "user",
        clientType: "web",
        network: "mainnet",
        metadata: {
          wallet: rawSecretWallet,
          token: rawSecretToken,
          secretKey: rawPrivateKey,
          email: "user@example.com",
        },
      });

      const serialized = JSON.stringify(sanitized);

      // Verify raw sensitive data is ABSENT
      expect(serialized).not.toContain(rawSecretUser);
      expect(serialized).not.toContain(rawSecretWallet);
      expect(serialized).not.toContain(rawSecretToken);
      expect(serialized).not.toContain(rawPrivateKey);
      expect(serialized).not.toContain("user@example.com");

      // Verify safe dimensions are present
      expect(sanitized.operation).toBe("portfolio.rebalance");
      expect(sanitized.route).toBe("/api/v1/portfolios/:uuid/rebalance");
      expect(sanitized.statusCode).toBe(200);
      expect(sanitized.statusCategory).toBe("2xx");
      expect(sanitized.errorCategory).toBe("NONE");
      expect(sanitized.actorType).toBe("user");
      expect(sanitized.clientType).toBe("web");
      expect(sanitized.network).toBe("mainnet");
      expect(sanitized.latencyMs).toBe(145.8);

      // Verify actorId was pseudonymised into a keyed hash
      expect(sanitized.actorHash).toBeDefined();
      expect(sanitized.actorHash).toHaveLength(64);
    });

    it("should compute daily rotating salt and hash actor deterministically per day", () => {
      const today = new Date("2026-09-26T12:00:00Z");
      const tomorrow = new Date("2026-09-27T12:00:00Z");

      const saltToday = getDailySalt(today);
      const saltTomorrow = getDailySalt(tomorrow);
      expect(saltToday).not.toEqual(saltTomorrow);

      const hash1 = hashActorId("user_123", saltToday);
      const hash2 = hashActorId("user_123", saltToday);
      const hashTomorrow = hashActorId("user_123", saltTomorrow);

      expect(hash1).toEqual(hash2);
      expect(hash1).not.toEqual(hashTomorrow);
    });

    it("should deep-scrub sensitive fields from arbitrary objects", () => {
      const input = {
        operation: "test.op",
        password: "secretpassword",
        token: "jwt.token.val",
        apiKey: "key_xyz",
        nested: {
          clientSecret: "shhh",
          safeField: "safeValue",
          deeper: {
            seedPhrase: "twelve secret words",
            anotherSafe: 1234,
          },
        },
      };

      const scrubbed = scrubSensitiveFields(input);
      expect(scrubbed.operation).toBe("test.op");
      expect(scrubbed).not.toHaveProperty("password");
      expect(scrubbed).not.toHaveProperty("token");
      expect(scrubbed).not.toHaveProperty("apiKey");
      expect((scrubbed.nested as any).safeField).toBe("safeValue");
      expect((scrubbed.nested as any)).not.toHaveProperty("clientSecret");
      expect((scrubbed.nested as any).deeper.anotherSafe).toBe(1234);
      expect((scrubbed.nested as any).deeper).not.toHaveProperty("seedPhrase");
    });

    it("should calculate latency statistical quantiles accurately", () => {
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const stats = calculateLatencyStats(latencies);

      expect(stats.count).toBe(10);
      expect(stats.minMs).toBe(10);
      expect(stats.maxMs).toBe(100);
      expect(stats.avgMs).toBe(55);
      expect(stats.p50Ms).toBe(55);
      expect(stats.p90Ms).toBeGreaterThanOrEqual(90);
      expect(stats.p99Ms).toBeGreaterThanOrEqual(99);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Service Aggregation & Insights Invariants
  // ---------------------------------------------------------------------------
  describe("MaintainerInsightsService", () => {
    let service: MaintainerInsightsService;
    let mockRepo: any;
    let savedRecords: any[];

    beforeEach(() => {
      savedRecords = [];
      mockRepo = {
        create: jest.fn((dto) => ({ ...dto, id: `metric-${Math.random()}` })),
        save: jest.fn(async (entity) => {
          if (Array.isArray(entity)) {
            savedRecords.push(...entity);
            return entity;
          }
          savedRecords.push(entity);
          return entity;
        }),
        find: jest.fn(async () => savedRecords),
        createQueryBuilder: jest.fn(() => {
          const qb: any = {
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getManyAndCount: jest.fn(async () => [savedRecords, savedRecords.length]),
            getMany: jest.fn(async () => savedRecords),
          };
          return qb;
        }),
        delete: jest.fn(async () => ({ affected: 2 })),
      };

      service = new MaintainerInsightsService(mockRepo);
    });

    it("should buffer and aggregate events by safe dimensions only", async () => {
      // Record 3 events for oracle.price_feed
      service.recordEvent({
        operation: "oracle.price_feed",
        route: "/api/v1/oracle/payloads",
        statusCode: 200,
        latencyMs: 30,
        actorId: "actor-alice",
        clientType: "agent",
        network: "mainnet",
      });

      service.recordEvent({
        operation: "oracle.price_feed",
        route: "/api/v1/oracle/payloads",
        statusCode: 200,
        latencyMs: 50,
        actorId: "actor-bob",
        clientType: "agent",
        network: "mainnet",
      });

      service.recordEvent({
        operation: "oracle.price_feed",
        route: "/api/v1/oracle/payloads",
        statusCode: 400,
        errorCode: "ORACLE_DRIFT",
        errorMessage: "Drift limit exceeded",
        latencyMs: 70,
        actorId: "actor-bob",
        clientType: "agent",
        network: "mainnet",
      });

      expect(service.getBufferSize()).toBe(3);

      const result = await service.flushAndAggregate(
        new Date("2026-09-26T14:00:00Z"),
        "hourly",
      );

      expect(result.processed).toBe(3);
      expect(result.aggregatesCreated).toBe(2); // 1 for 2xx (success), 1 for 4xx (failure)
      expect(service.getBufferSize()).toBe(0); // Buffer drained

      // Verify the saved records
      const successBucket = savedRecords.find((r) => r.statusCategory === "2xx");
      const failureBucket = savedRecords.find((r) => r.statusCategory === "4xx");

      expect(successBucket).toBeDefined();
      expect(successBucket.totalEvents).toBe(2);
      expect(successBucket.successCount).toBe(2);
      expect(successBucket.failureCount).toBe(0);
      expect(successBucket.uniqueActorsCount).toBe(2); // alice and bob
      expect(successBucket.avgLatencyMs).toBe(40);
      expect(successBucket.operation).toBe("oracle.price_feed");
      expect(successBucket.network).toBe("mainnet");

      expect(failureBucket).toBeDefined();
      expect(failureBucket.totalEvents).toBe(1);
      expect(failureBucket.failureCount).toBe(1);
      expect(failureBucket.errorCategory).toBe("ORACLE_DRIFT");
      expect(failureBucket.uniqueActorsCount).toBe(1); // bob

      // Verify NO raw sensitive values leaked into repository
      const serialized = JSON.stringify(savedRecords);
      expect(serialized).not.toContain("actor-alice");
      expect(serialized).not.toContain("actor-bob");
      expect(serialized).not.toContain("Drift limit exceeded");
    });

    it("should produce maintainer summary with totals, success rates, and breakdowns", async () => {
      savedRecords = [
        {
          id: "m-1",
          dateBucket: new Date("2026-09-26T14:00:00Z"),
          granularity: "hourly",
          operation: "oracle.price_feed",
          route: "/api/v1/oracle/payloads",
          statusCategory: "2xx",
          statusCode: 200,
          errorCategory: "NONE",
          clientType: "agent",
          network: "mainnet",
          actorType: "service_actor",
          totalEvents: 100,
          successCount: 95,
          failureCount: 5,
          uniqueActorsCount: 10,
          avgLatencyMs: 42.5,
          minLatencyMs: 12,
          maxLatencyMs: 150,
          p50LatencyMs: 40,
          p90LatencyMs: 80,
          p99LatencyMs: 140,
          errorBreakdown: { ORACLE_DRIFT: 5 },
        },
        {
          id: "m-2",
          dateBucket: new Date("2026-09-26T14:00:00Z"),
          granularity: "hourly",
          operation: "reconciliation.stellar",
          route: "/api/v1/reconcile/stellar",
          statusCategory: "2xx",
          statusCode: 200,
          errorCategory: "NONE",
          clientType: "operator",
          network: "mainnet",
          actorType: "operator",
          totalEvents: 50,
          successCount: 50,
          failureCount: 0,
          uniqueActorsCount: 3,
          avgLatencyMs: 85.0,
          minLatencyMs: 30,
          maxLatencyMs: 220,
          p50LatencyMs: 80,
          p90LatencyMs: 160,
          p99LatencyMs: 210,
          errorBreakdown: {},
        },
      ];

      const summary = await service.getSummary({
        granularity: MetricGranularity.HOURLY,
      });

      expect(summary.totals.totalEvents).toBe(150);
      expect(summary.totals.totalSuccess).toBe(145);
      expect(summary.totals.totalFailure).toBe(5);
      expect(summary.totals.successRatePercent).toBeCloseTo(96.67, 1);
      expect(summary.byOperation["oracle.price_feed"].events).toBe(100);
      expect(summary.byOperation["reconciliation.stellar"].events).toBe(50);
      expect(summary.byClientType["agent"]).toBe(100);
      expect(summary.byClientType["operator"]).toBe(50);
      expect(summary.byNetwork["mainnet"]).toBe(150);
      expect(summary.byErrorCategory["ORACLE_DRIFT"]).toBe(5);
    });

    it("should compute reliability insights including high-failure and slowest operations", async () => {
      savedRecords = [
        {
          id: "m-1",
          dateBucket: new Date("2026-09-26T14:00:00Z"),
          granularity: "hourly",
          operation: "defi.yield_harvest",
          statusCategory: "5xx",
          totalEvents: 20,
          successCount: 10,
          failureCount: 10,
          avgLatencyMs: 320,
          p99LatencyMs: 500,
          network: "mainnet",
          errorCategory: "INTERNAL_ERROR",
          errorBreakdown: { INTERNAL_ERROR: 10 },
        },
      ];

      const reliability = await service.getReliability({});
      expect(reliability.highFailureOperations[0].operation).toBe("defi.yield_harvest");
      expect(reliability.highFailureOperations[0].failureRatePercent).toBe(50);
      expect(reliability.slowestOperations[0].operation).toBe("defi.yield_harvest");
      expect(reliability.networkReliability["mainnet"].failures).toBe(10);
    });

    it("should purge expired hourly and daily metrics according to retention policy", async () => {
      const purgeResult = await service.purgeExpiredMetrics();
      expect(mockRepo.delete).toHaveBeenCalledTimes(2);
      expect(purgeResult.hourlyPurged).toBe(2);
      expect(purgeResult.dailyPurged).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Controller Invariants
  // ---------------------------------------------------------------------------
  describe("MaintainerInsightsController", () => {
    let controller: MaintainerInsightsController;
    let service: any;

    beforeEach(() => {
      service = {
        getSummary: jest.fn().mockResolvedValue({ status: "ok" }),
        getTimeseries: jest.fn().mockResolvedValue({ count: 0, metrics: [] }),
        getReliability: jest.fn().mockResolvedValue({ overallReliabilityPercent: 100 }),
        getPrivacyBoundaries: jest.fn().mockReturnValue(getPrivacyBoundarySpecification()),
        recordEvent: jest.fn().mockReturnValue({
          timeBucket: "2026-09-26T14:00:00.000Z",
          operation: "test.op",
          statusCategory: "2xx",
          errorCategory: "NONE",
          network: "mainnet",
          clientType: "agent",
        }),
        flushAndAggregate: jest.fn().mockResolvedValue({ processed: 5, aggregatesCreated: 2 }),
        purgeExpiredMetrics: jest.fn().mockResolvedValue({ hourlyPurged: 0, dailyPurged: 0 }),
      };

      controller = new MaintainerInsightsController(service);
    });

    it("should serve privacy boundary contract", () => {
      const spec = controller.getPrivacyBoundaries();
      expect(spec.safeDimensions).toBeDefined();
      expect(spec.forbiddenFields).toContain("password");
      expect(spec.forbiddenFields).toContain("token");
    });

    it("should delegate summary and timeseries requests to service", async () => {
      const mockReq = { headers: {}, query: {} } as any;
      await controller.getSummary({}, mockReq);
      expect(service.getSummary).toHaveBeenCalled();

      await controller.getTimeseries({}, mockReq);
      expect(service.getTimeseries).toHaveBeenCalled();

      await controller.getReliability({}, mockReq);
      expect(service.getReliability).toHaveBeenCalled();
    });

    it("should ingest events and return sanitized dimension response", () => {
      const mockReq = { headers: {}, query: {} } as any;
      const res = controller.recordEvent(
        {
          operation: "test.op",
          statusCode: 200,
          actorId: "actor-secret",
        },
        mockReq,
      );

      expect(res.status).toBe("ingested");
      expect(res.operation).toBe("test.op");
      expect(JSON.stringify(res)).not.toContain("actor-secret");
    });

    it("should allow manual trigger of aggregation and retention cleanup", async () => {
      const mockReq = { headers: {}, query: {} } as any;
      const aggRes = await controller.triggerAggregation({}, mockReq);
      expect(aggRes.success).toBe(true);
      expect(service.flushAndAggregate).toHaveBeenCalled();

      const purgeRes = await controller.triggerRetentionCleanup(mockReq);
      expect(purgeRes.success).toBe(true);
      expect(service.purgeExpiredMetrics).toHaveBeenCalled();
    });
  });
});
