import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PaymentProcessorRegistry } from "src/payments/registry/payment-processor.registry";
import { SandboxPaymentAdapter } from "src/sandbox/adapters/sandbox-payment.adapter";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import { SANDBOX_PROCESSOR_NAME } from "src/sandbox/sandbox.constants";

/**
 * Registers the sandbox payment processor, but only while sandbox mode is on.
 *
 * The real processors (`StellarAdapter`, `GrantfoxAdapter`) are auto-registered
 * by the `@RegisterPaymentProcessor()` discovery in `PaymentsModule`. The
 * sandbox processor deliberately does **not** use that decorator: registration
 * is gated on `SANDBOX_MODE` here, so a production deployment never even lists
 * a fake processor on `GET /payments/processors`.
 *
 * `SandboxModule` imports `PaymentsModule`, so Nest initialises
 * `PaymentsModule.onModuleInit` (which populates the registry) before this hook.
 */
@Injectable()
export class SandboxProcessorRegistrar implements OnModuleInit {
  private readonly logger = new Logger(SandboxProcessorRegistrar.name);

  constructor(
    private readonly registry: PaymentProcessorRegistry,
    private readonly adapter: SandboxPaymentAdapter,
    private readonly sandboxConfig: SandboxConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.sandboxConfig.get().enabled) {
      this.logger.log(
        `Sandbox mode off — "${SANDBOX_PROCESSOR_NAME}" processor not registered.`,
      );
      return;
    }

    if (this.sandboxConfig.isProduction()) {
      this.logger.error(
        `SANDBOX_MODE=true ignored because NODE_ENV=production — "${SANDBOX_PROCESSOR_NAME}" processor not registered.`,
      );
      return;
    }

    if (this.registry.has(SANDBOX_PROCESSOR_NAME)) {
      return;
    }

    this.registry.register(this.adapter);
    this.logger.warn(
      `Sandbox mode enabled — registered "${SANDBOX_PROCESSOR_NAME}" payment processor. Never use this in production.`,
    );
  }
}
