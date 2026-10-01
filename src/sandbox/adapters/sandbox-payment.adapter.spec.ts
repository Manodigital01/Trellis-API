import {
  BadRequestException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PaymentRequest,
  PaymentStatus,
} from "src/payments/interfaces/payment-processor.interface";
import { SandboxPaymentAdapter } from "src/sandbox/adapters/sandbox-payment.adapter";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import { SandboxScenario } from "src/sandbox/sandbox.scenarios";

/** Minimal ConfigService stub — only the keys we pass in are defined. */
function configStub(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

function buildAdapter(
  values: Record<string, unknown> = { SANDBOX_MODE: "true" },
): SandboxPaymentAdapter {
  return new SandboxPaymentAdapter(
    new SandboxConfigService(configStub(values)),
  );
}

function paymentRequest(
  overrides: Partial<PaymentRequest> = {},
): PaymentRequest {
  return {
    amount: "10",
    currency: "XLM",
    destination: "GBSANDBOXDESTINATION",
    source: "GBSANDBOXSOURCE",
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

async function runLifecycle(adapter: SandboxPaymentAdapter, request: PaymentRequest) {
  const created = await adapter.createPayment(request);
  const signed = await adapter.signTransaction(created);
  const submitted = await adapter.submitTransaction(signed);
  const status = await adapter.getStatus(submitted.transactionHash);
  const refund = await adapter.refund({
    paymentId: submitted.transactionHash,
    idempotencyKey: "refund-1",
  });
  return { created, signed, submitted, status, refund };
}

describe("SandboxPaymentAdapter", () => {
  it("runs the primary workflow with no production credentials configured", async () => {
    // Only SANDBOX_MODE is provided — no STELLAR_*, GRANTFOX_*, DATABASE_URL, …
    const config = configStub({ SANDBOX_MODE: "true" });
    const adapter = new SandboxPaymentAdapter(new SandboxConfigService(config));

    const { created, submitted, status, refund } = await runLifecycle(
      adapter,
      paymentRequest(),
    );

    expect(created.status).toBe(PaymentStatus.PENDING);
    expect(submitted.status).toBe(PaymentStatus.CONFIRMED);
    expect(status.status).toBe(PaymentStatus.CONFIRMED);
    expect(refund.status).toBe(PaymentStatus.REFUNDED);
    expect(refund.refundedAmount).toBe("10");

    expect(config.get("STELLAR_SIGNING_SECRET")).toBeUndefined();
    expect(config.get("STELLAR_HORIZON_URL")).toBeUndefined();
    expect(config.get("GRANTFOX_API_KEY")).toBeUndefined();
    expect(config.get("DATABASE_URL")).toBeUndefined();
  });

  it("returns byte-for-byte identical responses for the same seed and request", async () => {
    const request = paymentRequest();
    const same = buildAdapter({ SANDBOX_MODE: "true", SANDBOX_SEED: "seed-a" });

    const first = await runLifecycle(same, request);
    const second = await runLifecycle(same, request);
    const third = await runLifecycle(
      buildAdapter({ SANDBOX_MODE: "true", SANDBOX_SEED: "seed-a" }),
      request,
    );

    expect(third.created.paymentId).toBe(first.created.paymentId);
    expect(third.created.unsignedTransaction).toBe(
      first.created.unsignedTransaction,
    );
    expect(third.signed.signedPayload).toBe(first.signed.signedPayload);
    expect(third.submitted.transactionHash).toBe(
      first.submitted.transactionHash,
    );
    expect(third.refund.refundId).toBe(first.refund.refundId);
    expect(second.submitted.transactionHash).toBe(
      first.submitted.transactionHash,
    );
    expect(first.submitted.transactionHash).toMatch(/^sbx:success:tx:[0-9a-f]{32}$/);
  });

  it("changes generated ids when the seed changes", async () => {
    const request = paymentRequest();
    const a = await buildAdapter({
      SANDBOX_MODE: "true",
      SANDBOX_SEED: "seed-a",
    }).createPayment(request);
    const b = await buildAdapter({
      SANDBOX_MODE: "true",
      SANDBOX_SEED: "seed-b",
    }).createPayment(request);

    expect(b.paymentId).not.toBe(a.paymentId);
  });

  it("fails at create for the insufficient_funds scenario, deterministically", async () => {
    const adapter = buildAdapter();
    const request = paymentRequest({
      metadata: { sandboxScenario: SandboxScenario.INSUFFICIENT_FUNDS },
    });

    const first = await adapter.createPayment(request).catch((e) => e);
    const second = await adapter.createPayment(request).catch((e) => e);

    expect(first).toBeInstanceOf(BadRequestException);
    expect(second.message).toBe(first.message);
    expect(first.message).toContain("insufficient balance");
  });

  it("fails at submit with a retryable 503 for the horizon_timeout scenario", async () => {
    const adapter = buildAdapter();
    const created = await adapter.createPayment(
      paymentRequest({
        metadata: { sandboxScenario: SandboxScenario.HORIZON_TIMEOUT },
      }),
    );
    const signed = await adapter.signTransaction(created);

    await expect(adapter.submitTransaction(signed)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("settles payment_failed as FAILED and rejects the refund", async () => {
    const adapter = buildAdapter();
    const created = await adapter.createPayment(
      paymentRequest({
        metadata: { sandboxScenario: SandboxScenario.PAYMENT_FAILED },
      }),
    );
    const signed = await adapter.signTransaction(created);
    const submitted = await adapter.submitTransaction(signed);
    const status = await adapter.getStatus(submitted.transactionHash);

    expect(submitted.status).toBe(PaymentStatus.FAILED);
    expect(status.status).toBe(PaymentStatus.FAILED);
    await expect(
      adapter.refund({
        paymentId: submitted.transactionHash,
        idempotencyKey: "refund-1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("falls back to the configured scenario for a request without an override", async () => {
    const adapter = buildAdapter({
      SANDBOX_MODE: "true",
      SANDBOX_SCENARIO: SandboxScenario.PAYMENT_FAILED,
    });
    const created = await adapter.createPayment(paymentRequest());
    const signed = await adapter.signTransaction(created);
    const submitted = await adapter.submitTransaction(signed);

    expect(submitted.status).toBe(PaymentStatus.FAILED);
  });

  it("fails closed when sandbox mode is disabled", async () => {
    const adapter = buildAdapter({});
    await expect(
      adapter.createPayment(paymentRequest()),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it("fails closed in production even when SANDBOX_MODE=true", async () => {
    const adapter = buildAdapter({
      SANDBOX_MODE: "true",
      NODE_ENV: "production",
    });
    await expect(
      adapter.createPayment(paymentRequest()),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it("initialize resolves when enabled and throws when disabled", async () => {
    await expect(buildAdapter().initialize()).resolves.toBeUndefined();
    await expect(buildAdapter({}).initialize()).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
  });
});
