import { PreconditionFailedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SandboxConfigService, readSandboxConfig } from "src/sandbox/sandbox.config";
import { DEFAULT_SANDBOX_SEED } from "src/sandbox/sandbox.constants";
import { SandboxScenario } from "src/sandbox/sandbox.scenarios";

/** Minimal ConfigService stub — only the keys we pass in are defined. */
function configStub(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

describe("SandboxConfigService", () => {
  it("is disabled by default and falls back to the default seed and scenario", () => {
    expect(readSandboxConfig(configStub({}))).toEqual({
      enabled: false,
      scenario: SandboxScenario.SUCCESS,
      seed: DEFAULT_SANDBOX_SEED,
    });
    expect(new SandboxConfigService(configStub({})).isEnabled()).toBe(false);
  });

  it("enables only for the literal true value", () => {
    expect(
      readSandboxConfig(configStub({ SANDBOX_MODE: "true" })).enabled,
    ).toBe(true);
    expect(readSandboxConfig(configStub({ SANDBOX_MODE: true })).enabled).toBe(
      true,
    );
    expect(
      readSandboxConfig(configStub({ SANDBOX_MODE: "false" })).enabled,
    ).toBe(false);
    expect(readSandboxConfig(configStub({ SANDBOX_MODE: "yes" })).enabled).toBe(
      false,
    );
  });

  it("keeps a known scenario and falls back for unknown values", () => {
    expect(
      readSandboxConfig(
        configStub({ SANDBOX_SCENARIO: SandboxScenario.HORIZON_TIMEOUT }),
      ).scenario,
    ).toBe(SandboxScenario.HORIZON_TIMEOUT);
    expect(
      readSandboxConfig(configStub({ SANDBOX_SCENARIO: "does-not-exist" }))
        .scenario,
    ).toBe(SandboxScenario.SUCCESS);
  });

  it("uses a custom seed but ignores blank values", () => {
    expect(readSandboxConfig(configStub({ SANDBOX_SEED: "seed-a" })).seed).toBe(
      "seed-a",
    );
    expect(readSandboxConfig(configStub({ SANDBOX_SEED: "   " })).seed).toBe(
      DEFAULT_SANDBOX_SEED,
    );
  });

  it("assertEnabled throws while sandbox mode is disabled", () => {
    const service = new SandboxConfigService(configStub({}));
    expect(() => service.assertEnabled()).toThrow(PreconditionFailedException);
  });

  it("refuses to run in production even when SANDBOX_MODE=true", () => {
    const service = new SandboxConfigService(
      configStub({ SANDBOX_MODE: "true", NODE_ENV: "production" }),
    );
    expect(service.get().enabled).toBe(true);
    expect(service.isEnabled()).toBe(false);
    expect(() => service.assertEnabled()).toThrow(PreconditionFailedException);
  });
});
