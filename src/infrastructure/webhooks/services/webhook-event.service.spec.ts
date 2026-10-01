import { ConflictException } from "@nestjs/common";
import { Queue } from "bull";
import { Repository } from "typeorm";
import { WebhookEvent } from "../entities/webhook-event.entity";
import { WebhookSubscriptionService } from "./webhook-subscription.service";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookEventService } from "./webhook-event.service";

describe("WebhookEventService inbound replay claims", () => {
  it("rejects duplicate IDs at the database unique index before fan-out", async () => {
    const eventRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockRejectedValue({ driverError: { code: "23505" } }),
    };
    const subscriptions = { findActiveForEvent: jest.fn() };
    const deliveries = { createDeliveries: jest.fn() };
    const queue = { add: jest.fn() };
    const service = new WebhookEventService(
      eventRepository as unknown as Repository<WebhookEvent>,
      subscriptions as unknown as WebhookSubscriptionService,
      deliveries as unknown as WebhookDeliveryService,
      queue as unknown as Queue,
    );

    await expect(
      service.publishEvent(
        { eventType: "invoice.paid", payload: { id: "evt-1" } },
        { subscriptionId: "subscription-1", externalEventId: "evt-1" },
      ),
    ).rejects.toMatchObject({
      response: { statusCode: 409, reason: "duplicate_event" },
    } satisfies Partial<ConflictException>);

    expect(subscriptions.findActiveForEvent).not.toHaveBeenCalled();
    expect(deliveries.createDeliveries).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
