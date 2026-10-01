import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { PaymentWebhookService } from "./payment-webhook.service";
import { WebhookSignatureGuard } from "./webhook-signature.guard";
import {
  WEBHOOK_PROVIDERS,
  WebhookProvider,
} from "./webhook-signature.types";
import { VerifiedWebhookContext } from "./webhook-signature.guard";

/**
 * Provider → Trellis callbacks, authenticated by HMAC signature.
 *
 * Deliberately unauthenticated at the JWT layer: the caller is Stripe/Coinbase,
 * not a logged-in user, and the signature over the raw body is the credential.
 * `WebhookSignatureGuard` fails the request closed (400/503) before the handler
 * runs, and the handler answers `202` with a small ack — providers retry on
 * anything but a 2xx, so the response is only a receipt.
 */
@ApiTags("Payments")
@Controller("payments/webhooks")
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post(":provider")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(WebhookSignatureGuard)
  @ApiOperation({
    summary: "Receive a signed payment-provider webhook",
    description:
      "Verifies the provider HMAC signature against the raw request body, " +
      "enforces the replay window, and acknowledges the delivery. " +
      "The body is provider-specific and is not validated at the schema level.",
  })
  @ApiParam({
    name: "provider",
    enum: WEBHOOK_PROVIDERS,
    description: "Signature scheme to verify with.",
  })
  @ApiHeader({
    name: "Stripe-Signature",
    required: false,
    description: "Required for `stripe`: `t=<unix>,v1=<hmac-sha256 hex>`.",
  })
  @ApiHeader({
    name: "X-CC-Webhook-Signature",
    required: false,
    description: "Required for `coinbase`: hex HMAC-SHA256 of the raw body.",
  })
  @ApiHeader({
    name: "X-Webhook-Signature",
    required: false,
    description: "Required for `generic`: HMAC-SHA256 over `<unix>.<body>`.",
  })
  @ApiHeader({
    name: "X-Webhook-Timestamp",
    required: false,
    description:
      "Required for `generic` (for `stripe` the timestamp travels inside Stripe-Signature).",
  })
  @ApiResponse({
    status: 202,
    description: "Signature verified; delivery acknowledged.",
  })
  @ApiResponse({
    status: 400,
    description: "Missing, stale or invalid signature.",
  })
  @ApiResponse({
    status: 503,
    description: "No shared secret configured for this provider.",
  })
  handle(
    @Param("provider") provider: string,
    @Body() payload: unknown,
    @Req() request: RawBodyRequest<Request>,
  ) {
    // The guard already validated the provider and stored the resolved scheme;
    // the fallback only matters if this handler is ever wired without it.
    const verified = (
      request as RawBodyRequest<Request> & {
        verifiedWebhook?: VerifiedWebhookContext;
      }
    ).verifiedWebhook;

    return this.webhooks.accept({
      provider: (verified?.provider ??
        provider.toLowerCase()) as WebhookProvider,
      payload,
    });
  }
}
