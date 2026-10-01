import { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { createHmac } from "crypto";
import request from "supertest";
import { createGlobalValidationPipe } from "src/common/pipes/validation.pipe";
import { PaymentsModule } from "../payments.module";
import { PaymentOperation } from "../entities/payment-operation.entity";

/**
 * End-to-end proof that the payment webhook route is closed to anyone who
 * cannot sign with the provider secret.
 *
 * Real HTTP requests go through the raw-body middleware, the signature guard,
 * and the handler, exactly as in production; only the config is injected. Both
 * a genuine delivery and a forged one are exercised, because a guard that is
 * right about the happy path and wrong about the attack is worse than no guard.
 */
const STRIPE_SECRET = "whsec_e2e_stripe";
const GENERIC_SECRET = "e2e_generic_secret";

function stripeSignature(body: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", STRIPE_SECRET)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");

  return `t=${timestampSeconds},v1=${digest}`;
}

function genericSignature(body: string, timestampSeconds: number): string {
  return createHmac("sha256", GENERIC_SECRET)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");
}

/**
 * `rawBody` mirrors `main.ts`; leaving it off reproduces an app that never
 * preserved the payload, where verification must fail rather than fall back to
 * the parsed object.
 */
async function buildApp(options: {
  rawBody: boolean;
}): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            PAYMENTS_DEFAULT_PROCESSOR: "stellar",
            STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
            PAYMENTS_WEBHOOK_SECRET: GENERIC_SECRET,
          }),
        ],
      }),
      PaymentsModule,
    ],
  })
    // The webhook routes never touch payment operations; the repository is
    // only registered in PaymentsModule for the payments lifecycle (#154), so
    // an in-memory stub keeps this spec focused on signature verification.
    .overrideProvider(getRepositoryToken(PaymentOperation))
    .useValue({
      create: (values: Partial<PaymentOperation>) =>
        Object.assign(new PaymentOperation(), values),
      save: async (op: PaymentOperation) => op,
    })
    .compile();

  const app = moduleFixture.createNestApplication(
    options.rawBody ? { rawBody: true } : {},
  );
  app.useGlobalPipes(createGlobalValidationPipe());
  app.setGlobalPrefix("api/v1");
  await app.init();

  return app;
}

describe("Payment webhooks (e2e)", () => {
  let app: INestApplication;

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const webhookUrl = "/api/v1/payments/webhooks";

  beforeAll(async () => {
    app = await buildApp({ rawBody: true });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("valid deliveries", () => {
    it("accepts a signed Stripe event and acknowledges it", async () => {
      const body = JSON.stringify({
        id: "evt_live_1",
        type: "payment_intent.succeeded",
      });

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", stripeSignature(body, nowSeconds()))
        .send(body)
        .expect(202);

      expect(res.body).toMatchObject({
        accepted: true,
        provider: "stripe",
        eventId: "evt_live_1",
        eventType: "payment_intent.succeeded",
      });
      expect(typeof res.body.receivedAt).toBe("string");
    });

    it("verifies the exact bytes even when they are not canonical JSON", async () => {
      // Re-serialising this payload would change it, so acceptance proves the
      // digest was computed over the received bytes.
      const body = '{ "id" : "evt_odd",\n "type":"charge.refunded" }';

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", stripeSignature(body, nowSeconds()))
        .send(body)
        .expect(202);

      expect(res.body).toMatchObject({ eventId: "evt_odd" });
    });

    it("accepts a signed generic delivery and echoes unknown event fields", async () => {
      const body = JSON.stringify({ type: "payout.paid" });
      const timestamp = nowSeconds();

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/generic`)
        .set("Content-Type", "application/json")
        .set("X-Webhook-Signature", genericSignature(body, timestamp))
        .set("X-Webhook-Timestamp", String(timestamp))
        .send(body)
        .expect(202);

      expect(res.body).toMatchObject({
        accepted: true,
        provider: "generic",
        eventId: null,
        eventType: "payout.paid",
      });
    });
  });

  describe("forged deliveries", () => {
    it("rejects an unsigned request", async () => {
      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ type: "payment_intent.succeeded" }))
        .expect(400);

      expect(res.body).toMatchObject({ reason: "missing_signature" });
    });

    it("rejects a signature computed with the wrong secret", async () => {
      const body = JSON.stringify({ type: "payment_intent.succeeded" });
      const forged = createHmac("sha256", "whsec_attacker")
        .update(`${nowSeconds()}.${body}`, "utf8")
        .digest("hex");

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", `t=${nowSeconds()},v1=${forged}`)
        .send(body)
        .expect(400);

      expect(res.body).toMatchObject({
        reason: "invalid_signature",
        statusCode: 400,
      });
    });

    it("rejects a correctly signed body that was altered in transit", async () => {
      const signed = JSON.stringify({
        id: "evt_tamper",
        type: "payment_intent.succeeded",
      });
      const tampered = JSON.stringify({
        id: "evt_tamper",
        type: "payment_intent.succeeded",
        credits: 1000000,
      });

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", stripeSignature(signed, nowSeconds()))
        .send(tampered)
        .expect(400);

      expect(res.body).toMatchObject({ reason: "invalid_signature" });
    });

    it("rejects a replayed delivery older than five minutes", async () => {
      const body = JSON.stringify({ type: "payment_intent.succeeded" });
      const replayedAt = nowSeconds() - 360;

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", stripeSignature(body, replayedAt))
        .send(body)
        .expect(400);

      expect(res.body).toMatchObject({ reason: "stale_timestamp" });
    });

    it("rejects a delivery timestamped in the future", async () => {
      const body = JSON.stringify({ type: "payment_intent.succeeded" });
      const future = nowSeconds() + 600;

      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", stripeSignature(body, future))
        .send(body)
        .expect(400);

      expect(res.body).toMatchObject({ reason: "stale_timestamp" });
    });

    it("rejects an unknown provider", async () => {
      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/paypal`)
        .set("Content-Type", "application/json")
        .send("{}")
        .expect(400);

      expect(res.body).toMatchObject({ reason: "unknown_provider" });
    });

    it("answers 503 when no secret is configured for the provider", async () => {
      // COINBASE_WEBHOOK_SECRET is deliberately absent from this app's config.
      const res = await request(app.getHttpServer())
        .post(`${webhookUrl}/coinbase`)
        .set("Content-Type", "application/json")
        .set("X-CC-Webhook-Signature", "deadbeef")
        .send("{}")
        .expect(503);

      expect(res.body).toMatchObject({ reason: "secret_not_configured" });
    });
  });

  describe("fail closed without a raw body", () => {
    let appWithoutRawBody: INestApplication;

    beforeAll(async () => {
      appWithoutRawBody = await buildApp({ rawBody: false });
    });

    afterAll(async () => {
      await appWithoutRawBody.close();
    });

    it("rejects a delivery when the raw body was not preserved", async () => {
      const body = JSON.stringify({ type: "payment_intent.succeeded" });

      const res = await request(appWithoutRawBody.getHttpServer())
        .post(`${webhookUrl}/stripe`)
        .set("Content-Type", "application/json")
        .set("Stripe-Signature", stripeSignature(body, nowSeconds()))
        .send(body)
        .expect(400);

      expect(res.body).toMatchObject({ reason: "raw_body_unavailable" });
    });
  });
});
