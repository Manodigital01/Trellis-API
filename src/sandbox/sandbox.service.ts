import { Injectable, Logger } from "@nestjs/common";
import { PaymentRequest } from "src/payments/interfaces/payment-processor.interface";
import { SandboxPaymentAdapter } from "src/sandbox/adapters/sandbox-payment.adapter";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import { SANDBOX_PROCESSOR_NAME } from "src/sandbox/sandbox.constants";
import { SandboxScenario } from "src/sandbox/sandbox.scenarios";
import { listSandboxFixtures } from "src/sandbox/fixtures/sandbox.fixtures";

/** Input for {@link SandboxService.runPrimaryWorkflow}. All fields optional. */
export interface SandboxWorkflowInput {
  amount?: string;
  currency?: string;
  destination?: string;
  source?: string;
  idempotencyKey?: string;
  scenario?: SandboxScenario;
}

export interface SandboxWorkflowStep {
  step: string;
  detail: Record<string, unknown>;
}

export interface SandboxWorkflowResult {
  sandbox: true;
  scenario: SandboxScenario;
  /** False when the selected scenario failed at one of its steps. */
  ok: boolean;
  steps: SandboxWorkflowStep[];
  error?: string;
}

/** Limitations surfaced by {@link SandboxService.describe}. */
export const SANDBOX_LIMITATIONS: string[] = [
  "Only the payment workflow is sandboxed; the app still needs DATABASE_URL, JWT_SECRET and REDIS_URL to boot fully.",
  "The sandbox processor is registered only while SANDBOX_MODE=true, and never when NODE_ENV=production.",
  "Sandbox ids are prefixed 'sbx:' and are not valid ledger hashes — they must never reach a real network.",
  "Fixture state is in-memory and resets on restart; nothing is persisted.",
  "Sandbox mode is not a substitute for the Stellar testnet suite (npm run test:testnet).",
];

/**
 * Contributor-facing facade over sandbox mode.
 *
 * `runPrimaryWorkflow` drives the full create → sign → submit → status → refund
 * lifecycle through the sandbox adapter with no credentials, no network and no
 * database, which is what makes the primary workflow runnable locally.
 * `describe` exposes the active configuration, fixtures and limitations.
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  constructor(
    private readonly sandboxConfig: SandboxConfigService,
    private readonly paymentAdapter: SandboxPaymentAdapter,
  ) {}

  /** True when sandbox mode is on and the process is not in production. */
  isEnabled(): boolean {
    return this.sandboxConfig.isEnabled();
  }

  /** Active configuration, fixtures and documented limitations. */
  describe(): Record<string, unknown> {
    const config = this.sandboxConfig.get();
    return {
      enabled: this.isEnabled(),
      processor: SANDBOX_PROCESSOR_NAME,
      scenario: config.scenario,
      seed: config.seed,
      scenarios: listSandboxFixtures(),
      limitations: SANDBOX_LIMITATIONS,
    };
  }

  /**
   * Run the primary payment workflow end-to-end against the sandbox adapter.
   *
   * Never throws for a scenario failure — the failure is recorded in the
   * returned `error`/`steps` so a caller can render it. It does throw when
   * sandbox mode is disabled.
   */
  async runPrimaryWorkflow(
    input: SandboxWorkflowInput = {},
  ): Promise<SandboxWorkflowResult> {
    this.sandboxConfig.assertEnabled();
    const config = this.sandboxConfig.get();
    const scenario = input.scenario ?? config.scenario;
    const idempotencyKey = input.idempotencyKey ?? "sandbox-workflow-1";

    const request: PaymentRequest = {
      amount: input.amount ?? "10",
      currency: input.currency ?? "XLM",
      destination: input.destination ?? "GBSANDBOXDESTINATION",
      source: input.source ?? "GBSANDBOXSOURCE",
      idempotencyKey,
      metadata: { sandboxScenario: scenario },
    };

    const steps: SandboxWorkflowStep[] = [];
    try {
      const created = await this.paymentAdapter.createPayment(request);
      steps.push({
        step: "create",
        detail: { paymentId: created.paymentId, status: created.status },
      });

      const signed = await this.paymentAdapter.signTransaction(created);
      steps.push({
        step: "sign",
        detail: {
          paymentId: signed.paymentId,
          signerAddress: signed.signerAddress,
        },
      });

      const submitted = await this.paymentAdapter.submitTransaction(signed);
      steps.push({
        step: "submit",
        detail: {
          transactionHash: submitted.transactionHash,
          status: submitted.status,
        },
      });

      const status = await this.paymentAdapter.getStatus(
        submitted.transactionHash,
      );
      steps.push({
        step: "status",
        detail: {
          status: status.status,
          confirmedAmount: status.confirmedAmount,
        },
      });

      const refund = await this.paymentAdapter.refund({
        paymentId: submitted.transactionHash,
        idempotencyKey: `${idempotencyKey}:refund`,
      });
      steps.push({
        step: "refund",
        detail: {
          refundId: refund.refundId,
          status: refund.status,
          refundedAmount: refund.refundedAmount,
        },
      });

      return { sandbox: true, scenario, ok: true, steps };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[sandbox] workflow "${scenario}" stopped after ${steps.length} step(s): ${message}`,
      );
      return { sandbox: true, scenario, ok: false, steps, error: message };
    }
  }
}
