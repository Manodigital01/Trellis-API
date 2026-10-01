import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PaymentsModule } from "src/payments/payments.module";
import { SandboxPaymentAdapter } from "src/sandbox/adapters/sandbox-payment.adapter";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import { SandboxProcessorRegistrar } from "src/sandbox/sandbox-processor.registrar";
import { SandboxService } from "src/sandbox/sandbox.service";

/**
 * Integration sandbox mode (issue #57).
 *
 * Provides a credential-free, deterministic stand-in for the external payment
 * dependency plus a facade to run the primary workflow locally. The sandbox
 * processor is registered with the shared {@link PaymentProcessorRegistry} only
 * while `SANDBOX_MODE=true` — see {@link SandboxProcessorRegistrar}.
 *
 * Imports `PaymentsModule` for the registry only (Config/Http/Discovery — no
 * TypeORM/Bull/Redis), mirroring how `PaymentsModule` is built to boot
 * standalone in tests.
 */
@Module({
  imports: [ConfigModule, PaymentsModule],
  providers: [
    SandboxConfigService,
    SandboxPaymentAdapter,
    SandboxService,
    SandboxProcessorRegistrar,
  ],
  exports: [SandboxConfigService, SandboxPaymentAdapter, SandboxService],
})
export class SandboxModule {}
