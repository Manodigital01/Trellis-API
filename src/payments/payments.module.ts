import { HttpModule } from "@nestjs/axios";
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DiscoveryModule, DiscoveryService, Reflector } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Horizon } from "@stellar/stellar-sdk";
import { GrantfoxAdapter } from "./adapters/grantfox/grantfox.adapter";
import { StellarAdapter } from "./adapters/stellar/stellar.adapter";
import { STELLAR_HORIZON_SERVER } from "./adapters/stellar/stellar.constants";
import { HorizonNodePool } from "./adapters/stellar/horizon-node-pool";
import { ResilientHorizonProxy } from "./adapters/stellar/resilient-horizon-proxy";
import { PAYMENT_PROCESSOR_METADATA } from "./decorators/register-payment-processor.decorator";
import { IPaymentProcessor } from "./interfaces/payment-processor.interface";
import { PaymentOperation } from "./entities/payment-operation.entity";
import { PaymentProcessorFactory } from "./payment-processor.factory";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentProcessorRegistry } from "./registry/payment-processor.registry";
import { StellarPaymentsController } from "./stellar-payments.controller";
import { PaymentWebhookService } from "./webhooks/payment-webhook.service";
import { PaymentWebhooksController } from "./webhooks/payment-webhooks.controller";
import { RawBodyMiddleware } from "./webhooks/raw-body.middleware";
import { WebhookSignatureGuard } from "./webhooks/webhook-signature.guard";
import { WebhookSignatureService } from "./webhooks/webhook-signature.service";

/**
 * Wires the payment-processor plugin system.
 *
 * Imports only Config/Http/Discovery (no TypeORM/Bull/Redis) so the module
 * boots standalone in integration tests. Adapters tagged with
 * `@RegisterPaymentProcessor()` are auto-registered on init — adding a new
 * processor means adding one provider here (or anywhere Nest can discover it),
 * with no change to the registry, factory, controller, or this init logic.
 *
 * The Stellar Horizon `Server` is provided via {@link STELLAR_HORIZON_SERVER}
 * so tests can override it with an in-memory fake (no network I/O offline).
 */

/** DI token for the Horizon node pool + failover policy (issue #160). */
export const HORIZON_NODE_POOL = "HORIZON_NODE_POOL";

@Module({
  // PaymentOperation backs the create → sign → submit checkpoints in
  // PaymentsService (#154). Registered here so the repository token resolves
  // in every module context, including integration tests.
  imports: [
    ConfigModule,
    HttpModule,
    DiscoveryModule,
    TypeOrmModule.forFeature([PaymentOperation]),
  ],
  // Static segments MUST precede dynamic ones: both
  // `payments/webhooks/:provider` and `payments/stellar/{submit,status}` would
  // otherwise be shadowed by the generic `payments/:id/{submit,status}` routes
  // (Express matches in registration order). See the notes in
  // stellar-payments.controller.ts and webhooks/payment-webhooks.controller.ts.
  controllers: [
    PaymentWebhooksController,
    StellarPaymentsController,
    PaymentsController,
  ],
  providers: [
    PaymentProcessorRegistry,
    PaymentProcessorFactory,
    PaymentsService,
    WebhookSignatureService,
    PaymentWebhookService,
    WebhookSignatureGuard,
    RawBodyMiddleware,
    StellarAdapter,
    GrantfoxAdapter,
    {
      provide: HORIZON_NODE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new HorizonNodePool(config as any),
    },
    {
      // Issue #160: serve Horizon RPC through a failover proxy so a degraded
      // primary node (timeout, 5xx, network error) transparently retries and
      // falls over to the configured fallback nodes without interrupting the
      // payment flow. With a single configured node this is behaviour-neutral
      // (retries only).
      provide: STELLAR_HORIZON_SERVER,
      inject: [HORIZON_NODE_POOL],
      useFactory: (pool: HorizonNodePool) =>
        new ResilientHorizonProxy(pool, (url) => new Horizon.Server(url))
          .target,
    },
  ],
  exports: [PaymentProcessorRegistry, PaymentProcessorFactory, PaymentsService],
})
export class PaymentsModule implements OnModuleInit, NestModule {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly registry: PaymentProcessorRegistry,
  ) {}

  /**
   * Preserve the exact bytes of a webhook delivery before any guard runs.
   *
   * Scoped to the webhook route so the rest of the API keeps its parsed body
   * and no other endpoint pays the cost of retaining a second copy.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RawBodyMiddleware).forRoutes({
      path: "payments/webhooks/:provider",
      method: RequestMethod.POST,
    });
  }

  /**
   * Discover every provider tagged `@RegisterPaymentProcessor()` and register
   * it. Matching only on our metadata key keeps this from picking up the DeFi
   * protocol adapters (which lack the key).
   */
  onModuleInit(): void {
    for (const wrapper of this.discoveryService.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) {
        continue;
      }
      const isProcessor = this.reflector.get<boolean>(
        PAYMENT_PROCESSOR_METADATA,
        metatype,
      );
      if (isProcessor) {
        this.registry.register(instance as IPaymentProcessor);
      }
    }
  }
}
