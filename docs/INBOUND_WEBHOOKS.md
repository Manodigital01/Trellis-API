# Inbound Webhooks

`POST /api/v1/webhooks/inbound/:subscriptionId` accepts signed JSON callbacks for an active webhook subscription. The request must include `X-Webhook-Timestamp` as Unix seconds and `X-Webhook-Signature` as `sha256=<hex HMAC-SHA256>`. The digest is computed over the exact raw request bytes prefixed by `<timestamp>.`; the timestamp and body are therefore bound together.

The JSON object must contain a non-empty `id` (or `eventId`) and `type` (or `eventType`). Its type must be enabled by the subscription. Sign with that subscription's `signingKey`; do not include or send the key in the request. The default replay window is 300 seconds and can be changed with `WEBHOOK_REPLAY_WINDOW_SECONDS`.

PostgreSQL atomically enforces uniqueness on `(sourceSubscriptionId, externalEventId)` before deliveries are created. A second valid request with the same event ID receives HTTP 409 with reason `duplicate_event`; invalid signatures, malformed input, and stale timestamps receive structured HTTP 400 responses. Apply migration `AddInboundWebhookReplayKeys1791072000000` before deploying the inbound route.

Example signature generation:

````ts
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = `sha256=${createHmac("sha256", signingKey)
  .update(`${timestamp}.${rawJsonBody}`, "utf8")
  .digest("hex")}`;
```# Inbound Webhooks

`POST /api/v1/webhooks/inbound/:subscriptionId` accepts a JSON event for an active webhook subscription. The request must include `X-Webhook-Timestamp` as Unix seconds and `X-Webhook-Signature` as `sha256=<hex>`. The HMAC-SHA256 is calculated over the exact raw request bytes prefixed by `<timestamp>.`; both timestamp and body are therefore bound to the signature. The default timestamp tolerance is 300 seconds and can be configured with `WEBHOOK_REPLAY_WINDOW_SECONDS`.

The signed JSON object must contain a non-empty `id` (or `eventId`) and `type` (or `eventType`). Only event types enabled on the subscription are accepted. The server stores the event ID with the subscription in `webhook_events` under a unique index before fan-out. Repeated IDs return HTTP 409 with `reason: "duplicate_event"`; invalid signatures, stale timestamps, and malformed requests return structured HTTP 400 errors.

Apply the TypeORM migration `AddInboundWebhookReplayKeys1791072000000` before deploying. A sender can compute the signature as:

```ts
createHmac("sha256", signingKey)
  .update(`${timestamp}.${rawBody}`, "utf8")
  .digest("hex");
````
