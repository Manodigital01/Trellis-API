import { ConfigService } from "@nestjs/config";
import { PaymentProcessorRegistry } from "src/payments/registry/payment-processor.registry";
import { SandboxPaymentAdapter } from "src/sandbox/adapters/sandbox-payment.adapter";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import { SandboxProcessorRegistrar } from "src/sandbox/sandbox-processor.registrar";
import { SANDBOX_PROCESSOR_NAME } from "src/sandbox/sandbox.constants";
import {
  SANDBOX_LIMITATIONS,
  SandboxService,
} from "src/sandbox/sandbox.service";
import { SandboxScenario } from "src/sandbox/sandbox.scenarios";

/** Minimal ConfigService stub — only the keys we pass in are defined. */
function configStub(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

function buildSandbox(
  values: Record<string, unknown> = { SANDBOX_MODE: "true" },
): { service: SandboxService; adapter: SandboxPaymentAdapter; config: SandboxConfigService } {
  const config = new SandboxConfigService(configStub(values));
  const adapter = new SandboxPaymentAdapter(config);
  return { service: new SandboxService(config, adapter), adapter, config };
}

describe("SandboxService", () => {
  it("runs the primary workflow end-to-end and reports every step", async () => {
    const { service } = buildSandbox();
    const result = await service.runPrimaryWorkflow();

    expect(result.ok).toBe(true);
    expect(result.sandbox).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "create",
      "sign",
      "submit",
      "status",
      "refund",
    ]);
    expect(result.error).toBeUndefined();
  });

  it("is deterministic across runs", async () => {
    const { service } = buildSandbox({
      SANDBOX_MODE: "true",
      SANDBOX_SEED: "seed-a",
    });

    const first = await service.runPrimaryWorkflow();
    const second = await service.runPrimaryWorkflow();

    expect(second.steps).toEqual(first.steps);
  });

  it("records a scenario failure instead of throwing", async () => {
    const { service } = buildSandbox();
    const result = await service.runPrimaryWorkflow({
      scenario: SandboxScenario.INSUFFICIENT_FUNDS,
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(result.error).toContain("insufficient balance");
  });

  it("stops after the failing step for a submit failure", async () => {
    const { service } = buildSandbox();
    const result = await service.runPrimaryWorkflow({
      scenario: SandboxScenario.HORIZON_TIMEOUT,
    });

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.step)).toEqual(["create", "sign"]);
    expect(result.error).toContain("retry is safe");
  });

  it("describes the active configuration, fixtures and limitations", () => {
    const { service } = buildSandbox();
    const described = service.describe();

    expect(described.enabled).toBe(true);
    expect(described.processor).toBe(SANDBOX_PROCESSOR_NAME);
    expect(described.limitations).toEqual(SANDBOX_LIMITATIONS);
    expect(described.scenarios).toHaveLength(4);
  });

  it("throws when sandbox mode is disabled", async () => {
    const { service } = buildSandbox({});
    await expect(service.runPrimaryWorkflow()).rejects.toThrow(
      "Sandbox mode is disabled",
    );
    expect(service.isEnabled()).toBe(false);
  });
});

describe("SandboxProcessorRegistrar", () => {
  function buildRegistry(): PaymentProcessorRegistry {
    return {
      has: jest.fn().mockReturnValue(false),
      register: jest.fn(),
    } as unknown as PaymentProcessorRegistry;
  }

  it("registers the sandbox processor when sandbox mode is enabled", () => {
    const registry = buildRegistry();
    const { adapter, config } = buildSandbox();
    new SandboxProcessorRegistrar(registry, adapter, config).onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(adapter);
  });

  it("does not register anything when sandbox mode is disabled", () => {
    const registry = buildRegistry();
    const { adapter, config } = buildSandbox({});
    new SandboxProcessorRegistrar(registry, adapter, config).onModuleInit();

    expect(registry.register).not.toHaveBeenCalled();
  });

  it("does not register in production even when SANDBOX_MODE=true", () => {
    const registry = buildRegistry();
    const { adapter, config } = buildSandbox({
      SANDBOX_MODE: "true",
      NODE_ENV: "production",
    });
    new SandboxProcessorRegistrar(registry, adapter, config).onModuleInit();

    expect(registry.register).not.toHaveBeenCalled();
  });

  it("does not double-register an already present processor", () => {
    const registry = buildRegistry();
    (registry.has as jest.Mock).mockReturnValue(true);
    const { adapter, config } = buildSandbox();
    new SandboxProcessorRegistrar(registry, adapter, config).onModuleInit();

    expect(registry.register).not.toHaveBeenCalled();
  });
});
