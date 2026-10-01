import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";

@Injectable()
export class WebhookHmacService {
  /**
   * Compute HMAC-SHA256 signature for a webhook payload.
   * Returns the hex-encoded signature prefixed with "sha256=".
   */
  sign(payload: string, secret: string): string {
    const signature = createHmac("sha256", secret)
      .update(payload, "utf8")
      .digest("hex");
    return `sha256=${signature}`;
  }

  /** Sign the timestamp and exact body together to prevent timestamp swapping. */
  signTimestamped(
    payload: string | Buffer,
    secret: string,
    timestamp: string,
  ): string {
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.`, "utf8")
      .update(payload)
      .digest("hex");
    return `sha256=${signature}`;
  }

  /**
   * Build the standard webhook request headers including the HMAC signature.
   */
  buildSignedHeaders(
    signingKey: string,
    payload: string,
    eventId: string,
    eventType: string,
    extraHeaders?: Record<string, string>,
  ): Record<string, string> {
    const signature = this.sign(payload, signingKey);
    return {
      "Content-Type": "application/json",
      "X-Webhook-Event-Id": eventId,
      "X-Webhook-Event-Type": eventType,
      "X-Webhook-Signature": signature,
      "X-Webhook-Timestamp": Date.now().toString(),
      "User-Agent": "Trellis-Webhook/1.0",
      ...extraHeaders,
    };
  }

  /**
   * Verify an incoming HMAC signature (useful for echo/test endpoints).
   */
  verify(payload: string, secret: string, receivedSignature: string): boolean {
    return this.matches(this.sign(payload, secret), receivedSignature);
  }

  verifyTimestamped(
    payload: string | Buffer,
    secret: string,
    timestamp: string,
    receivedSignature: string,
  ): boolean {
    return this.matches(
      this.signTimestamped(payload, secret, timestamp),
      receivedSignature,
    );
  }

  private matches(expected: string, receivedSignature: string): boolean {
    const expectedBytes = Buffer.from(expected, "utf8");
    const receivedBytes = Buffer.from(receivedSignature, "utf8");

    if (expectedBytes.length !== receivedBytes.length) return false;

    try {
      return timingSafeEqual(expectedBytes, receivedBytes);
    } catch {
      return false;
    }
  }
}
