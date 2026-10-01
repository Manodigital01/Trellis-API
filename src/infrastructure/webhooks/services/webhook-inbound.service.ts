import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
} from "../entities/webhook-subscription.entity";
import { WebhookEvent } from "../entities/webhook-event.entity";
import { WebhookHmacService } from "./webhook-hmac.service";
import { WebhookEventService } from "./webhook-event.service";

export const DEFAULT_INBOUND_WEBHOOK_TOLERANCE_SECONDS = 300;

@Injectable()
export class WebhookInboundService {
  constructor(
    @InjectRepository(WebhookSubscription)
    private readonly subscriptions: Repository<WebhookSubscription>,
    private readonly events: WebhookEventService,
    private readonly hmac: WebhookHmacService,
    private readonly config: ConfigService,
  ) {}

  async accept(
    subscriptionId: string,
    rawBody: Buffer | string | null | undefined,
    headers: Record<string, string | string[] | undefined>,
    now = Date.now(),
  ): Promise<{ accepted: true; duplicate: false; event: WebhookEvent }> {
    const body = this.readBody(rawBody);
    if (body === null) {
      this.fail(400, "malformed_event", "Raw request body is unavailable.");
    }

    const timestamp = this.header(headers, "x-webhook-timestamp");
    if (timestamp === null) {
      this.fail(
        400,
        "missing_timestamp",
        "Missing X-Webhook-Timestamp header.",
      );
    }
    if (!/^\d{1,12}$/.test(timestamp)) {
      this.fail(
        400,
        "malformed_timestamp",
        "Webhook timestamp must be unix seconds.",
      );
    }

    const timestampSeconds = Number(timestamp);
    const tolerance = this.toleranceSeconds;
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(Math.floor(now / 1000) - timestampSeconds) > tolerance
    ) {
      this.fail(
        400,
        "stale_timestamp",
        `Webhook timestamp is outside the ${tolerance}s replay window.`,
      );
    }

    const signature = this.header(headers, "x-webhook-signature");
    if (signature === null) {
      this.fail(
        400,
        "missing_signature",
        "Missing X-Webhook-Signature header.",
      );
    }

    const subscription = await this.subscriptions.findOne({
      where: { id: subscriptionId, status: WebhookSubscriptionStatus.ACTIVE },
    });
    if (!subscription) {
      throw new NotFoundException({
        statusCode: 404,
        error: "Not Found",
        reason: "subscription_not_found",
        message: "Active webhook subscription not found.",
      });
    }

    if (
      !this.hmac.verifyTimestamped(
        Buffer.isBuffer(rawBody) ? rawBody : body,
        subscription.signingKey,
        timestamp,
        signature,
      )
    ) {
      this.fail(400, "invalid_signature", "Invalid webhook signature.");
    }

    const payload = this.parsePayload(body);
    const eventId =
      this.nonEmptyString(payload.id) ?? this.nonEmptyString(payload.eventId);
    const eventType =
      this.nonEmptyString(payload.type) ??
      this.nonEmptyString(payload.eventType);

    if (
      !eventId ||
      eventId.length > 255 ||
      !eventType ||
      eventType.length > 255
    ) {
      this.fail(
        400,
        "malformed_event",
        "Webhook body must contain a non-empty id/eventId and type/eventType of at most 255 characters.",
      );
    }
    if (
      !subscription.events.includes("*") &&
      !subscription.events.includes(eventType)
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        error: "Forbidden",
        reason: "event_type_not_allowed",
        message: "Event type is not enabled for this subscription.",
      });
    }

    const event = await this.events.publishEvent(
      {
        eventType,
        payload,
        aggregateId: this.nonEmptyString(payload.aggregateId),
      },
      { subscriptionId: subscription.id, externalEventId: eventId },
    );
    return { accepted: true, duplicate: false, event };
  }

  private get toleranceSeconds(): number {
    const configured = Number(
      this.config.get<string | number>(
        "WEBHOOK_REPLAY_WINDOW_SECONDS",
        DEFAULT_INBOUND_WEBHOOK_TOLERANCE_SECONDS,
      ),
    );
    return Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_INBOUND_WEBHOOK_TOLERANCE_SECONDS;
  }

  private readBody(rawBody: Buffer | string | null | undefined): string | null {
    if (Buffer.isBuffer(rawBody)) {
      return rawBody.length > 0 ? rawBody.toString("utf8") : null;
    }
    return typeof rawBody === "string" && rawBody.length > 0 ? rawBody : null;
  }

  private header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | null {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value.find(
        (entry) => typeof entry === "string" && entry.trim(),
      );
      return first?.trim() ?? null;
    }
    return null;
  }

  private parsePayload(body: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.fail(400, "malformed_event", "Webhook body must be valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.fail(400, "malformed_event", "Webhook body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private fail(status: number, reason: string, message: string): never {
    throw new HttpException(
      {
        statusCode: status,
        error: status === 409 ? "Conflict" : "Bad Request",
        reason,
        message,
      },
      status,
    );
  }
}
