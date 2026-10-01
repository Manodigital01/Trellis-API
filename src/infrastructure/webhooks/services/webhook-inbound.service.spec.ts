import { ConflictException } from "@nestjs/common";
import { createHmac } from "crypto";
import { WebhookEvent } from "../entities/webhook-event.entity";
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from "../entities/webhook-subscription.entity";
import { WebhookEventService } from "./webhook-event.service";
import { WebhookHmacService } from "./webhook-hmac.service";
import { WebhookInboundService } from "./webhook-inbound.service";

const SECRET = "inbound_test_secret";
const SUBSCRIPTION_ID = "a14c12d9-d238-4fd9-a19f-81e5cbd024d8";
const NOW = 1_800_000_000_000;

function makeSignature(body: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex")}`;
}

function buildService(
  publishEvent = jest.fn().mockResolvedValue({ id: "stored-event" }),
) {
  const subscription = {
    id: SUBSCRIPTION_ID,
    signingKey: SECRET,
    status: WebhookSubscriptionStatus.ACTIVE,
    events: ["invoice.paid"],
  } as WebhookSubscription;
  const subscriptions = {
    findOne: jest.fn().mockResolvedValue(subscription),
  };
  const events = { publishEvent } as unknown as WebhookEventService;
  const config = { get: jest.fn((_key, fallback) => fallback) } as any;
  const service = new WebhookInboundService(
    subscriptions as any,
    events,
    new WebhookHmacService(),
    config,
  );

  return { service, subscriptions, publishEvent };
}

function signedRequest(body: string, timestamp = String(NOW / 1000)) {
  return {
    body: Buffer.from(body),
    headers: {
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": makeSignature(body, timestamp),
    },
  };
}

describe("WebhookInboundService", () => {
  const payload = JSON.stringify({ id: "evt-1", type: "invoice.paid" });

  it("accepts a valid signed event and persists it once before dispatch", async () => {
    const { service, publishEvent } = buildService();
    const request = signedRequest(payload);

    const result = await service.accept(
      SUBSCRIPTION_ID,
      request.body,
      request.headers,
      NOW,
    );

    expect(result).toMatchObject({ accepted: true, duplicate: false });
    expect(publishEvent).toHaveBeenCalledWith(
      {
        eventType: "invoice.paid",
        payload: { id: "evt-1", type: "invoice.paid" },
        aggregateId: null,
      },
      { subscriptionId: SUBSCRIPTION_ID, externalEventId: "evt-1" },
    );
  });

  it("rejects an invalid signature without dispatching", async () => {
    const { service, publishEvent } = buildService();
    const request = signedRequest(payload);

    await expect(
      service.accept(
        SUBSCRIPTION_ID,
        request.body,
        { ...request.headers, "x-webhook-signature": "sha256=wrong" },
        NOW,
      ),
    ).rejects.toMatchObject({
      response: { reason: "invalid_signature" },
      status: 400,
    });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed stale timestamp", async () => {
    const { service, publishEvent } = buildService();
    const staleTimestamp = String(NOW / 1000 - 301);
    const request = signedRequest(payload, staleTimestamp);

    await expect(
      service.accept(SUBSCRIPTION_ID, request.body, request.headers, NOW),
    ).rejects.toMatchObject({
      response: { reason: "stale_timestamp" },
      status: 400,
    });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("returns a structured conflict for a duplicate event ID", async () => {
    const { service } = buildService(
      jest.fn().mockRejectedValue(
        new ConflictException({
          statusCode: 409,
          reason: "duplicate_event",
          message: "This webhook event ID has already been processed.",
        }),
      ),
    );
    const request = signedRequest(payload);

    await expect(
      service.accept(SUBSCRIPTION_ID, request.body, request.headers, NOW),
    ).rejects.toMatchObject({
      response: { reason: "duplicate_event" },
      status: 409,
    });
  });

  it("rejects malformed signed JSON before persistence", async () => {
    const { service, publishEvent } = buildService();
    const request = signedRequest("{");

    await expect(
      service.accept(SUBSCRIPTION_ID, request.body, request.headers, NOW),
    ).rejects.toMatchObject({
      response: { reason: "malformed_event" },
      status: 400,
    });
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it("rejects a non-object body and missing event identifiers", async () => {
    const { service, publishEvent } = buildService();
    const primitive = signedRequest("[]");
    await expect(
      service.accept(SUBSCRIPTION_ID, primitive.body, primitive.headers, NOW),
    ).rejects.toMatchObject({ response: { reason: "malformed_event" } });

    const missingId = signedRequest(JSON.stringify({ type: "invoice.paid" }));
    await expect(
      service.accept(SUBSCRIPTION_ID, missingId.body, missingId.headers, NOW),
    ).rejects.toMatchObject({ response: { reason: "malformed_event" } });
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
import { ConflictException, HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WebhookEvent } from "../entities/webhook-event.entity";
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from "../entities/webhook-subscription.entity";
import { WebhookEventService } from "./webhook-event.service";
import { WebhookHmacService } from "./webhook-hmac.service";
import { WebhookInboundService } from "./webhook-inbound.service";

const NOW = 1_700_000_000_000;
const TIMESTAMP = String(Math.floor(NOW / 1000));
const SECRET = "whsec_inbound_test";
const BODY = JSON.stringify({
  id: "evt-123",
  type: "invoice.paid",
  amount: 42,
});

const subscription = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  signingKey: SECRET,
  status: WebhookSubscriptionStatus.ACTIVE,
  events: ["invoice.paid"],
} as WebhookSubscription;

const signedHeaders = (body = BODY, timestamp = TIMESTAMP) => {
  const hmac = new WebhookHmacService();
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": hmac.signTimestamped(body, SECRET, timestamp),
  };
};

const makeService = (
  overrides: {
    hmac?: WebhookHmacService;
    publishEvent?: jest.Mock;
  } = {},
) => {
  const subscriptions = {
    findOne: jest.fn().mockResolvedValue(subscription),
  };
  const events = {
    publishEvent:
      overrides.publishEvent ??
      jest.fn().mockResolvedValue({ id: "event-db-1" }),
  };
  const hmac = overrides.hmac ?? new WebhookHmacService();
  const config = {
    get: jest.fn((_key: string, fallback: number) => fallback),
  } as unknown as ConfigService;

  return {
    service: new WebhookInboundService(
      subscriptions as any,
      events as unknown as WebhookEventService,
      hmac,
      config,
    ),
    subscriptions,
    events,
  };
};

const expectReason = async (
  promise: Promise<unknown>,
  reason: string,
  statusCode: number,
) => {
  await expect(promise).rejects.toMatchObject({
    response: { reason, statusCode },
    status: statusCode,
  });
};

describe("WebhookInboundService", () => {
  it("accepts a valid raw-body signature and publishes one claimed event", async () => {
    const { service, events } = makeService();

    const result = await service.accept(
      subscription.id,
      Buffer.from(BODY),
      signedHeaders(),
      NOW,
    );

    expect(result).toMatchObject({ accepted: true, duplicate: false });
    expect(events.publishEvent).toHaveBeenCalledWith(
      {
        eventType: "invoice.paid",
        payload: { id: "evt-123", type: "invoice.paid", amount: 42 },
        aggregateId: null,
      },
      { subscriptionId: subscription.id, externalEventId: "evt-123" },
    );
  });

  it("rejects an invalid signature before persisting or dispatching", async () => {
    const { service, events } = makeService();
    const headers = signedHeaders();
    headers["x-webhook-signature"] = "sha256=invalid";

    await expectReason(
      service.accept(subscription.id, BODY, headers, NOW),
      "invalid_signature",
      400,
    );
    expect(events.publishEvent).not.toHaveBeenCalled();
  });

  it("rejects a stale signed request before dispatch", async () => {
    const { service, events } = makeService();
    const stale = String(Number(TIMESTAMP) - 301);

    await expectReason(
      service.accept(subscription.id, BODY, signedHeaders(BODY, stale), NOW),
      "stale_timestamp",
      400,
    );
    expect(events.publishEvent).not.toHaveBeenCalled();
  });

  it("rejects a duplicate valid event using the durable unique-claim result", async () => {
    const { service } = makeService({
      publishEvent: jest.fn().mockRejectedValue(
        new ConflictException({
          statusCode: 409,
          error: "Conflict",
          reason: "duplicate_event",
          message: "This webhook event ID has already been processed.",
        }),
      ),
    });

    await expectReason(
      service.accept(subscription.id, BODY, signedHeaders(), NOW),
      "duplicate_event",
      409,
    );
  });

  it("rejects malformed JSON and events without signed identifiers", async () => {
    const { service, events } = makeService();

    await expectReason(
      service.accept(subscription.id, "{", signedHeaders("{"), NOW),
      "malformed_event",
      400,
    );
    const withoutId = JSON.stringify({ type: "invoice.paid" });
    await expectReason(
      service.accept(subscription.id, withoutId, signedHeaders(withoutId), NOW),
      "malformed_event",
      400,
    );
    expect(events.publishEvent).not.toHaveBeenCalled();
  });
});
