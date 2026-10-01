import { Injectable, Logger } from "@nestjs/common";
import { WebhookProvider } from "./webhook-signature.types";

export interface WebhookAck {
  accepted: true;
  provider: WebhookProvider;
  /** Provider event id when the payload carries one, else `null`. */
  eventId: string | null;
  /** Provider event type when the payload carries one, else `null`. */
  eventType: string | null;
  receivedAt: string;
}

export interface AcceptWebhookInput {
  provider: WebhookProvider;
  /** Parsed payload, already proven to come from the provider. */
  payload: unknown;
  receivedAt?: Date;
}

/**
 * Entry point for verified provider callbacks.
 *
 * Signature verification happens in the guard, so anything reaching this
 * service is authenticated. It normalises the provider-specific envelope
 * (Stripe puts the event at the root, Coinbase nests it under `event`) and
 * acknowledges it. Business handling — crediting a payment, flipping an invoice
 * to `paid` — belongs to the processor registry and stays out of the request
 * path: providers retry on any non-2xx, so the handler must stay fast and
 * idempotent, and the ack reports only what was received.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  accept(input: AcceptWebhookInput): WebhookAck {
    const { eventId, eventType } = normalizeEvent(
      input.provider,
      input.payload,
    );

    this.logger.log(
      `Accepted ${input.provider} webhook${eventType ? ` (${eventType})` : ""}${
        eventId ? ` id=${eventId}` : ""
      }`,
    );

    return {
      accepted: true,
      provider: input.provider,
      eventId,
      eventType,
      receivedAt: (input.receivedAt ?? new Date()).toISOString(),
    };
  }
}

/** Pulls `id`/`type` out of the provider-specific envelope. */
function normalizeEvent(
  provider: WebhookProvider,
  payload: unknown,
): { eventId: string | null; eventType: string | null } {
  const root = asRecord(payload) ?? {};
  const envelope =
    provider === "coinbase" ? (asRecord(root.event) ?? root) : root;

  return {
    eventId: asString(envelope.id),
    eventType: asString(envelope.type) ?? asString(root.type),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
