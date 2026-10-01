import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  WebhookSignatureService,
} from "./webhook-signature.service";

const STRIPE_SECRET = "whsec_test_stripe";
const COINBASE_SECRET = "cb_test_shared_secret";
const GENERIC_SECRET = "generic_test_shared_secret";

function serviceWith(env: Record<string, string | number | undefined>) {
  const config = {
    get: (key: string, fallback?: unknown) =>
      env[key] !== undefined ? env[key] : fallback,
  } as unknown as ConfigService;

  return new WebhookSignatureService(config);
}

/** Stripe's scheme: `t=<unix>,v1=<hex hmac of "<t>.<body>">`. */
function stripeHeader(
  body: string,
  secret = STRIPE_SECRET,
  timestampSeconds = Math.floor(Date.now() / 1000),
) {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");

  return { value: `t=${timestampSeconds},v1=${digest}`, timestampSeconds };
}

function genericHeader(
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
  encoding: "hex" | "base64" = "hex",
  secret = GENERIC_SECRET,
) {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest(encoding);

  return { digest, timestampSeconds };
}

const PAYLOAD = JSON.stringify({
  id: "evt_1",
  type: "payment_intent.succeeded",
});

describe("WebhookSignatureService", () => {
  describe("stripe scheme", () => {
    it("accepts a correctly signed delivery", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value, timestampSeconds } = stripeHeader(PAYLOAD);

      const result = service.verify({
        provider: "stripe",
        headers: { "stripe-signature": value },
        rawBody: Buffer.from(PAYLOAD, "utf8"),
      });

      expect(result).toEqual({
        ok: true,
        provider: "stripe",
        timestampSeconds,
      });
    });

    it("verifies over the raw bytes, not a re-serialised object", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      // Same JSON value, deliberately different bytes: extra spaces, newlines,
      // and a different key order. Re-encoding would break this signature.
      const rawBody = '{ "type" : "payment_intent.succeeded",\n  "id":"evt_1" }';
      const { value } = stripeHeader(rawBody);

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": value },
          rawBody,
        }),
      ).toMatchObject({ ok: true });
    });

    it("rejects a forged signature", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value } = stripeHeader(PAYLOAD, "whsec_attacker");

      const result = service.verify({
        provider: "stripe",
        headers: { "stripe-signature": value },
        rawBody: PAYLOAD,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "invalid_signature",
        status: 400,
      });
    });

    it("rejects a valid signature over a tampered payload", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value } = stripeHeader(PAYLOAD);
      const tampered = JSON.stringify({
        id: "evt_1",
        type: "payment_intent.succeeded",
        amount: 999999,
      });

      const result = service.verify({
        provider: "stripe",
        headers: { "stripe-signature": value },
        rawBody: tampered,
      });

      expect(result).toMatchObject({ ok: false, reason: "invalid_signature" });
    });

    it("rejects a replay older than the 5 minute window", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
      const { value } = stripeHeader(PAYLOAD, STRIPE_SECRET, staleTimestamp);

      const result = service.verify({
        provider: "stripe",
        headers: { "stripe-signature": value },
        rawBody: PAYLOAD,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "stale_timestamp",
        status: 400,
      });
    });

    it("accepts a timestamp inside the tolerance window", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value } = stripeHeader(
        PAYLOAD,
        STRIPE_SECRET,
        Math.floor(Date.now() / 1000) - 299,
      );

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": value },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: true });
    });

    it("rejects a timestamp far in the future", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value } = stripeHeader(
        PAYLOAD,
        STRIPE_SECRET,
        Math.floor(Date.now() / 1000) + 3600,
      );

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": value },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "stale_timestamp" });
    });

    it("honours a custom tolerance", () => {
      const service = serviceWith({
        STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
        PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: 60,
      });
      const { value } = stripeHeader(
        PAYLOAD,
        STRIPE_SECRET,
        Math.floor(Date.now() / 1000) - 120,
      );

      expect(service.toleranceSeconds).toBe(60);
      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": value },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "stale_timestamp" });
    });

    it("requires both the timestamp and the digest", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": "v1=deadbeef" },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "missing_timestamp" });

      // Fresh timestamp but no `v1=` digest: nothing to compare against.
      expect(
        service.verify({
          provider: "stripe",
          headers: {
            "stripe-signature": `t=${Math.floor(Date.now() / 1000)}`,
          },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "malformed_signature" });
    });

    it("rejects a non-numeric timestamp", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": "t=not-a-time,v1=deadbeef" },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "malformed_timestamp" });
    });

    it("rejects a delivery with no signature header", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      expect(
        service.verify({
          provider: "stripe",
          headers: {},
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "missing_signature", status: 400 });
    });
  });

  describe("coinbase scheme", () => {
    it("accepts a hex digest of the raw body without a timestamp", () => {
      const service = serviceWith({ COINBASE_WEBHOOK_SECRET: COINBASE_SECRET });
      const digest = createHmac("sha256", COINBASE_SECRET)
        .update(PAYLOAD, "utf8")
        .digest("hex");

      expect(
        service.verify({
          provider: "coinbase",
          headers: { "x-cc-webhook-signature": digest },
          rawBody: PAYLOAD,
        }),
      ).toEqual({ ok: true, provider: "coinbase", timestampSeconds: null });
    });

    it("rejects a digest in the wrong encoding", () => {
      const service = serviceWith({ COINBASE_WEBHOOK_SECRET: COINBASE_SECRET });
      const base64 = createHmac("sha256", COINBASE_SECRET)
        .update(PAYLOAD, "utf8")
        .digest("base64");

      expect(
        service.verify({
          provider: "coinbase",
          headers: { "x-cc-webhook-signature": base64 },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "invalid_signature" });
    });

    it("still checks a timestamp when the provider sends one", () => {
      const service = serviceWith({ COINBASE_WEBHOOK_SECRET: COINBASE_SECRET });
      const stale = Math.floor(Date.now() / 1000) - 900;
      const digest = createHmac("sha256", COINBASE_SECRET)
        .update(PAYLOAD, "utf8")
        .digest("hex");

      expect(
        service.verify({
          provider: "coinbase",
          headers: {
            "x-cc-webhook-signature": digest,
            "x-cc-webhook-timestamp": String(stale),
          },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "stale_timestamp" });
    });
  });

  describe("generic scheme", () => {
    it("accepts base64 and `sha256=`-prefixed hex digests", () => {
      const service = serviceWith({ PAYMENTS_WEBHOOK_SECRET: GENERIC_SECRET });
      const { digest, timestampSeconds } = genericHeader(PAYLOAD, undefined, "base64");

      expect(
        service.verify({
          provider: "generic",
          headers: {
            "x-webhook-signature": `sha256=${digest}`,
            "x-webhook-timestamp": String(timestampSeconds),
          },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: true, provider: "generic" });
    });

    it("accepts the `x-hub-signature-256` header alias", () => {
      const service = serviceWith({ PAYMENTS_WEBHOOK_SECRET: GENERIC_SECRET });
      const { digest, timestampSeconds } = genericHeader(PAYLOAD);

      expect(
        service.verify({
          provider: "generic",
          headers: {
            "x-hub-signature-256": `sha256=${digest}`,
            "x-timestamp": String(timestampSeconds),
          },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: true });
    });

    it("falls back to the secondary secret env var", () => {
      const service = serviceWith({ WEBHOOK_HMAC_SECRET: "secondary_secret" });
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac("sha256", "secondary_secret")
        .update(`${timestamp}.${PAYLOAD}`, "utf8")
        .digest("hex");

      expect(
        service.verify({
          provider: "generic",
          headers: {
            "x-webhook-signature": digest,
            "x-webhook-timestamp": String(timestamp),
          },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: true });
    });

    it("requires a timestamp", () => {
      const service = serviceWith({ PAYMENTS_WEBHOOK_SECRET: GENERIC_SECRET });
      const { digest } = genericHeader(PAYLOAD);

      expect(
        service.verify({
          provider: "generic",
          headers: { "x-webhook-signature": digest },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "missing_timestamp" });
    });
  });

  describe("configuration and input handling", () => {
    it("rejects an unknown provider", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      const result = service.verify({
        provider: "paypal",
        headers: {},
        rawBody: PAYLOAD,
      });

      expect(result).toMatchObject({ ok: false, reason: "unknown_provider" });
      expect(result).toHaveProperty("message", expect.stringContaining("stripe"));
    });

    it("answers 503 when the provider secret is not configured", () => {
      const service = serviceWith({});

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": "t=1,v1=abc" },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "secret_not_configured", status: 503 });
    });

    it("ignores a blank secret", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: "   " });

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": "t=1,v1=abc" },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "secret_not_configured" });
    });

    it("rejects a delivery whose raw body is unavailable or empty", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value } = stripeHeader(PAYLOAD);

      for (const rawBody of [undefined, null, "", Buffer.alloc(0)]) {
        expect(
          service.verify({
            provider: "stripe",
            headers: { "stripe-signature": value },
            rawBody,
          }),
        ).toMatchObject({ ok: false, reason: "raw_body_unavailable", status: 400 });
      }
    });

    it("matches the provider case-insensitively", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const { value } = stripeHeader(PAYLOAD);

      expect(
        service.verify({
          provider: "Stripe",
          headers: { "stripe-signature": value },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: true, provider: "stripe" });
    });

    it("defaults the tolerance to five minutes", () => {
      expect(
        serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET }).toleranceSeconds,
      ).toBe(DEFAULT_WEBHOOK_TOLERANCE_SECONDS);
      expect(DEFAULT_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    });

    it("falls back to the default when the configured tolerance is unusable", () => {
      expect(
        serviceWith({ PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: "abc" })
          .toleranceSeconds,
      ).toBe(DEFAULT_WEBHOOK_TOLERANCE_SECONDS);
      expect(
        serviceWith({ PAYMENTS_WEBHOOK_TOLERANCE_SECONDS: -5 }).toleranceSeconds,
      ).toBe(DEFAULT_WEBHOOK_TOLERANCE_SECONDS);
    });

    it("ignores an empty signature header value", () => {
      const service = serviceWith({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      expect(
        service.verify({
          provider: "stripe",
          headers: { "stripe-signature": "  " },
          rawBody: PAYLOAD,
        }),
      ).toMatchObject({ ok: false, reason: "missing_signature" });
    });
  });
});
