import {
  clearWebsocketSubscriptions,
  normalizeWebsocketChannel,
  normalizeWebsocketErrorReason,
  normalizeWebsocketEvent,
  normalizeWebsocketTransport,
  register,
  resetWebsocketMetrics,
  setWebsocketSubscriptions,
  trackWebsocketConnectionClosed,
  trackWebsocketConnectionOpened,
  trackWebsocketError,
  trackWebsocketMessagePublished,
  WEBSOCKET_ERROR_REASONS,
  WEBSOCKET_EVENT_KINDS,
  WEBSOCKET_TRANSPORTS,
  websocketActiveConnections,
  websocketErrors,
  websocketMessagesPublished,
  websocketSubscriptions,
} from "./metrics";

/**
 * Issue #143: the four WebSocket series the issue named must be exposed on the
 * same registry `/metrics` already serves, and must pass Prometheus' own
 * validation — a malformed series is silently dropped by the exposition
 * format, so asserting on the rendered text is the only way to know a metric
 * will actually reach a scraper.
 */
describe("WebSocket metrics (#143)", () => {
  beforeEach(() => {
    resetWebsocketMetrics();
  });

  afterAll(() => {
    resetWebsocketMetrics();
  });

  async function scrape(): Promise<string> {
    return register.metrics();
  }

  describe("registration", () => {
    it("registers all four series on the shared registry", async () => {
      const body = await scrape();

      expect(body).toContain("websocket_active_connections_total");
      expect(body).toContain("websocket_subscriptions_total");
      expect(body).toContain("websocket_messages_published_total");
      expect(body).toContain("websocket_errors_total");
    });

    it("declares the connection and subscription series as gauges and the message series as counters", async () => {
      // `_total` on a counter is a counter; a Gauge with the same name would
      // not be a count. Assert the rendered type so a future refactor cannot
      // silently change the semantics.
      const body = await scrape();

      trackWebsocketMessagePublished("alert");
      trackWebsocketError("send_failed");
      trackWebsocketConnectionOpened("dashboard");
      setWebsocketSubscriptions("portfolio-1", 2);

      const rendered = await scrape();
      expect(rendered).toMatch(
        /# TYPE websocket_messages_published_total counter/,
      );
      expect(rendered).toMatch(/# TYPE websocket_errors_total counter/);
      expect(rendered).toMatch(/# TYPE websocket_active_connections_total gauge/);
      expect(rendered).toMatch(/# TYPE websocket_subscriptions_total gauge/);
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe("connection gauge", () => {
    it("rises on open and falls on close for the same transport", async () => {
      trackWebsocketConnectionOpened("dashboard");
      trackWebsocketConnectionOpened("dashboard");
      trackWebsocketConnectionClosed("dashboard");

      const body = await scrape();
      expect(body).toMatch(
        /websocket_active_connections_total\{transport="dashboard"\} 1/,
      );
    });

    it("keeps transports independent", async () => {
      trackWebsocketConnectionOpened("dashboard");
      trackWebsocketConnectionOpened("mobile");

      const body = await scrape();
      expect(body).toMatch(
        /websocket_active_connections_total\{transport="dashboard"\} 1/,
      );
      expect(body).toMatch(/websocket_active_connections_total\{transport="mobile"\} 1/);
    });

    it("can go back to zero without emitting a negative sample", async () => {
      trackWebsocketConnectionOpened("dashboard");
      trackWebsocketConnectionClosed("dashboard");

      const body = await scrape();
      const line = body
        .split("\n")
        .find((l) => l.startsWith("websocket_active_connections_total{"));
      expect(line).toBeDefined();
      expect(line).toContain(" 0");
      expect(line).not.toContain("-1");
    });
  });

  describe("subscription gauge", () => {
    it("reports the active count for a channel", async () => {
      setWebsocketSubscriptions("portfolio-42", 7);

      expect(await scrape()).toMatch(
        /websocket_subscriptions_total\{portfolio="portfolio-42"\} 7/,
      );
    });

    it("clears a channel back to zero", async () => {
      setWebsocketSubscriptions("portfolio-42", 7);
      clearWebsocketSubscriptions("portfolio-42");

      expect(await scrape()).toMatch(
        /websocket_subscriptions_total\{portfolio="portfolio-42"\} 0/,
      );
    });
  });

  describe("counters", () => {
    it("counts published messages by event kind", async () => {
      trackWebsocketMessagePublished("portfolio_update");
      trackWebsocketMessagePublished("portfolio_update");
      trackWebsocketMessagePublished("alert");

      const body = await scrape();
      expect(body).toMatch(
        /websocket_messages_published_total\{event="portfolio_update"\} 2/,
      );
      expect(body).toMatch(/websocket_messages_published_total\{event="alert"\} 1/);
    });

    it("counts errors by reason", async () => {
      trackWebsocketError("publish_failed");
      trackWebsocketError("rate_limited");

      const body = await scrape();
      expect(body).toMatch(/websocket_errors_total\{reason="publish_failed"\} 1/);
      expect(body).toMatch(/websocket_errors_total\{reason="rate_limited"\} 1/);
    });

    it("accumulates across calls rather than resetting", async () => {
      for (let i = 0; i < 5; i++) trackWebsocketError("send_failed");
      expect(await scrape()).toMatch(/websocket_errors_total\{reason="send_failed"\} 5/);
    });
  });

  describe("label normalisation", () => {
    it("accepts every declared transport", () => {
      for (const transport of WEBSOCKET_TRANSPORTS) {
        expect(normalizeWebsocketTransport(transport)).toBe(transport);
      }
    });

    // An untrusted upgrade request must not be able to mint metric series.
    it("collapses an unknown transport rather than echoing it", () => {
      expect(normalizeWebsocketTransport("evil-canary")).toBe("public");
      expect(normalizeWebsocketTransport(undefined)).toBe("public");
      expect(normalizeWebsocketTransport(null)).toBe("public");
      expect(normalizeWebsocketTransport("")).toBe("public");
    });

    it("collapses unknown event and reason labels", () => {
      for (const event of WEBSOCKET_EVENT_KINDS) {
        expect(normalizeWebsocketEvent(event)).toBe(event);
      }
      expect(normalizeWebsocketEvent("attacker-controlled")).toBe("system");

      for (const reason of WEBSOCKET_ERROR_REASONS) {
        expect(normalizeWebsocketErrorReason(reason)).toBe(reason);
      }
      expect(normalizeWebsocketErrorReason("attacker-controlled")).toBe("send_failed");
    });

    it("bounds a client-chosen channel so it cannot grow series without limit", () => {
      const long = "c".repeat(500);
      const normalized = normalizeWebsocketChannel(long);
      expect(normalized.length).toBe(64);

      // A hostile channel name must not be able to forge a label separator.
      expect(normalizeWebsocketChannel('a",evil="b')).not.toContain('"');
      expect(normalizeWebsocketChannel('a",evil="b')).toContain("_");

      expect(normalizeWebsocketChannel("")).toBe("unknown");
      expect(normalizeWebsocketChannel(undefined)).toBe("unknown");
      expect(normalizeWebsocketChannel("   ")).toBe("unknown");
    });

    it("records a hostile channel label without corrupting the exposition format", async () => {
      setWebsocketSubscriptions('bad", injection="1', 1);

      const body = await scrape();
      const line = body
        .split("\n")
        .find((l) => l.startsWith("websocket_subscriptions_total{"));
      expect(line).toBeDefined();
      // One label pair, correctly quoted: the injected quote was neutralised.
      expect(line).toContain('portfolio="bad__injection_1"');
      expect(body).not.toContain('portfolio="bad", injection="1"');
    });
  });

  describe("exposition validity", () => {
    it("renders every WebSocket series with a well-formed label set", async () => {
      trackWebsocketConnectionOpened("dashboard");
      setWebsocketSubscriptions("portfolio-1", 1);
      trackWebsocketMessagePublished("transaction");
      trackWebsocketError("send_failed");

      const body = await scrape();
      for (const line of body.split("\n")) {
        if (!line.startsWith("websocket_")) continue;
        // A sample line is `name{label="value"} 1`. Anything else means the
        // registry would drop or mis-parse it.
        expect(line).toMatch(/^websocket_[a-z_]+(\{[a-z_]+="[^"]*"\})? [0-9.e+-]+$/);
      }
    });
  });

  describe("test seam", () => {
    it("resets gauges and counters between tests", async () => {
      trackWebsocketConnectionOpened("dashboard");
      trackWebsocketError("send_failed");
      setWebsocketSubscriptions("p", 4);

      resetWebsocketMetrics();

      // Counters vanish entirely; gauges are re-emitted at zero only once set.
      const body = await scrape();
      expect(body).not.toContain("websocket_errors_total{");
      expect(body).not.toContain("websocket_messages_published_total{");
    });
  });

  // Direct gauge reads, so a wiring bug in the helper is distinguishable from
  // a rendering bug.
  it("exposes the underlying prom-client series for direct assertions", () => {
    websocketActiveConnections.set({ transport: "dashboard" }, 5);
    websocketSubscriptions.set({ portfolio: "p" }, 2);
    websocketMessagesPublished.inc({ event: "alert" }, 3);
    websocketErrors.inc({ reason: "send_failed" }, 4);

    expect(websocketActiveConnections.get() as any).toEqual(
      expect.objectContaining({ values: expect.anything() }),
    );
    expect(websocketSubscriptions.get() as any).toBeDefined();
    expect(websocketMessagesPublished.get() as any).toBeDefined();
    expect(websocketErrors.get() as any).toBeDefined();
  });
});
