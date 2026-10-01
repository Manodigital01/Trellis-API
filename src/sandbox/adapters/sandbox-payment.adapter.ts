import { Injectable, Logger } from "@nestjs/common";
import {
  CreatedPayment,
  IPaymentProcessor,
  PaymentCapabilities,
  PaymentRequest,
  PaymentStatusResult,
  RefundRequest,
  RefundResult,
  SignedTransaction,
  SubmittedTransaction,
} from "src/payments/interfaces/payment-processor.interface";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import {
  SANDBOX_PROCESSOR_NAME,
  SANDBOX_SIGNER_ADDRESS,
} from "src/sandbox/sandbox.constants";
import {
  sandboxPaymentId,
  sandboxRefundId,
  sandboxSignedPayload,
  sandboxTransactionHash,
  sandboxUnsignedPayload,
  scenarioFromSandboxId,
} from "src/sandbox/sandbox.determinism";
import {
  SandboxScenario,
  isSandboxScenario,
} from "src/sandbox/sandbox.scenarios";
import {
  SandboxFixture,
  getSandboxFixture,
  sandboxFailureException,
} from "src/sandbox/fixtures/sandbox.fixtures";

/**
 * Deterministic, credential-free payment processor used for integration
 * sandbox mode (issue #57).
 *
 * Implements the same {@link IPaymentProcessor} contract as the real
 * {@link StellarAdapter} / `GrantfoxAdapter`, but every call is served from
 * {@link SANDBOX_FIXTURES} with ids derived from a configurable seed. There is
 * no network I/O, no database, and no secret required — the only input is the
 * request itself, so the same request always yields the same response.
 *
 * Safety: every entry point calls
 * {@link SandboxConfigService.assertEnabled}, so this adapter fails closed
 * (`412 Precondition Failed`) unless `SANDBOX_MODE=true` and the process is not
 * in production. It is also only registered in the payment-processor registry
 * while sandbox mode is on (see `SandboxProcessorRegistrar`).
 */
@Injectable()
export class SandboxPaymentAdapter implements IPaymentProcessor {
  readonly name = SANDBOX_PROCESSOR_NAME;
  readonly displayName = "Sandbox (deterministic)";
  readonly capabilities: PaymentCapabilities = {
    supportsPartialRefund: true,
    requiresClientSideSigning: false,
    currencies: ["XLM", "USD", "EUR", "USDC", "SANDBOX"],
  };

  private readonly logger = new Logger(SandboxPaymentAdapter.name);

  constructor(private readonly sandboxConfig: SandboxConfigService) {}

  /** Fails closed unless sandbox mode is enabled and we are not in production. */
  async initialize(): Promise<void> {
    this.sandboxConfig.assertEnabled();
  }

  async createPayment(request: PaymentRequest): Promise<CreatedPayment> {
    const { seed, scenario, fixture } = this.resolve(
      request.metadata?.sandboxScenario,
    );
    if (fixture.failure?.step === "create") {
      throw sandboxFailureException(fixture.failure);
    }

    const paymentId = sandboxPaymentId(seed, scenario, request.idempotencyKey);
    const created: CreatedPayment = {
      paymentId,
      status: fixture.createStatus,
      unsignedTransaction: sandboxUnsignedPayload(
        scenario,
        paymentId,
        request.idempotencyKey,
      ),
      raw: { sandbox: true, scenario },
    };
    this.logger.debug(`[sandbox] create ${scenario} -> ${paymentId}`);
    return created;
  }

  async signTransaction(created: CreatedPayment): Promise<SignedTransaction> {
    const { scenario, fixture } = this.resolveFrom(created.unsignedTransaction);
    if (fixture.failure?.step === "sign") {
      throw sandboxFailureException(fixture.failure);
    }

    return {
      paymentId: created.paymentId,
      signedPayload: sandboxSignedPayload(scenario, created.paymentId),
      signerAddress: SANDBOX_SIGNER_ADDRESS,
    };
  }

  async submitTransaction(
    signed: SignedTransaction,
  ): Promise<SubmittedTransaction> {
    const { seed, scenario, fixture } = this.resolveFrom(signed.signedPayload);
    if (fixture.failure?.step === "submit") {
      throw sandboxFailureException(fixture.failure);
    }

    return {
      paymentId: signed.paymentId,
      transactionHash: sandboxTransactionHash(
        seed,
        scenario,
        signed.paymentId,
      ),
      status: fixture.submitStatus,
      raw: { sandbox: true, scenario },
    };
  }

  async getStatus(paymentId: string): Promise<PaymentStatusResult> {
    const { scenario, fixture } = this.resolveFrom(paymentId);
    if (fixture.failure?.step === "status") {
      throw sandboxFailureException(fixture.failure);
    }

    return {
      paymentId,
      status: fixture.statusStatus,
      transactionHash: paymentId,
      confirmedAmount: fixture.confirmedAmount,
      raw: { sandbox: true, scenario },
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const { seed, scenario, fixture } = this.resolveFrom(request.paymentId);
    if (fixture.failure?.step === "refund") {
      throw sandboxFailureException(fixture.failure);
    }

    return {
      refundId: sandboxRefundId(
        seed,
        scenario,
        request.paymentId,
        request.idempotencyKey,
      ),
      paymentId: request.paymentId,
      status: fixture.refundStatus,
      refundedAmount: request.amount ?? fixture.confirmedAmount,
      raw: { sandbox: true, scenario },
    };
  }

  /** Resolve scenario/fixture from an optional request override. */
  private resolve(rawScenario: unknown): {
    seed: string;
    scenario: SandboxScenario;
    fixture: SandboxFixture;
  } {
    this.sandboxConfig.assertEnabled();
    const config = this.sandboxConfig.get();
    const scenario = isSandboxScenario(rawScenario)
      ? rawScenario
      : config.scenario;
    return {
      seed: config.seed,
      scenario,
      fixture: getSandboxFixture(scenario),
    };
  }

  /**
   * Resolve scenario/fixture from a sandbox id or payload, falling back to the
   * configured default when the value was not produced by this module.
   */
  private resolveFrom(value: unknown): {
    seed: string;
    scenario: SandboxScenario;
    fixture: SandboxFixture;
  } {
    this.sandboxConfig.assertEnabled();
    const config = this.sandboxConfig.get();
    const scenario = scenarioFromSandboxId(value) ?? config.scenario;
    return {
      seed: config.seed,
      scenario,
      fixture: getSandboxFixture(scenario),
    };
  }
}
