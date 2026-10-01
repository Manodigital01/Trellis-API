import { Injectable, PreconditionFailedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DEFAULT_SANDBOX_SEED,
  SANDBOX_MODE_ENV,
  SANDBOX_SCENARIO_ENV,
  SANDBOX_SEED_ENV,
} from "./sandbox.constants";
import {
  DEFAULT_SANDBOX_SCENARIO,
  SandboxScenario,
  isSandboxScenario,
} from "./sandbox.scenarios";

/** Resolved sandbox configuration. */
export interface SandboxConfig {
  /** Whether sandbox mode is switched on (`SANDBOX_MODE=true`). */
  enabled: boolean;
  /** Scenario used when a request does not name one. */
  scenario: SandboxScenario;
  /** Seed that makes generated ids/hashes reproducible. */
  seed: string;
}

/** Parse the boolean-ish values ConfigService can return (`true` | `"true"`). */
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * Resolve sandbox configuration from a {@link ConfigService}. Unknown or blank
 * `SANDBOX_SCENARIO` values fall back to {@link DEFAULT_SANDBOX_SCENARIO} so a
 * typo can never silently disable sandbox mode.
 */
export function readSandboxConfig(configService: ConfigService): SandboxConfig {
  const rawScenario = configService.get<string>(SANDBOX_SCENARIO_ENV);
  const rawSeed = configService.get<string>(SANDBOX_SEED_ENV);
  const scenario = isSandboxScenario(rawScenario)
    ? rawScenario
    : DEFAULT_SANDBOX_SCENARIO;

  return {
    enabled: toBoolean(configService.get(SANDBOX_MODE_ENV)),
    scenario,
    seed: rawSeed && rawSeed.trim() ? rawSeed : DEFAULT_SANDBOX_SEED,
  };
}

/**
 * Read-only view over the sandbox configuration, injected wherever sandbox
 * behaviour must be gated. Mirrors {@link FeatureFlagsService}: configuration
 * lives in `ConfigService`, callers ask a small typed service.
 *
 * Safety: {@link assertEnabled} refuses to run when `NODE_ENV=production`, so
 * even a misconfigured deployment cannot route traffic to the fake adapters.
 */
@Injectable()
export class SandboxConfigService {
  constructor(private readonly configService: ConfigService) {}

  /** Current resolved configuration. */
  get(): SandboxConfig {
    return readSandboxConfig(this.configService);
  }

  /** True when `SANDBOX_MODE=true` and we are not running in production. */
  isEnabled(): boolean {
    return this.get().enabled && !this.isProduction();
  }

  /** True when the process is running with `NODE_ENV=production`. */
  isProduction(): boolean {
    return this.configService.get<string>("NODE_ENV") === "production";
  }

  /**
   * Guard for every sandbox adapter entry point.
   *
   * @throws PreconditionFailedException when sandbox mode is off, or when it is
   * on but the process is in production.
   */
  assertEnabled(): void {
    if (!this.get().enabled) {
      throw new PreconditionFailedException(
        "Sandbox mode is disabled. Set SANDBOX_MODE=true to use the sandbox adapters.",
      );
    }
    if (this.isProduction()) {
      throw new PreconditionFailedException(
        "Sandbox mode cannot be used when NODE_ENV=production.",
      );
    }
  }
}
