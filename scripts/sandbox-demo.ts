#!/usr/bin/env ts-node
/**
 * Trellis API — sandbox workflow demo (issue #57)
 * ────────────────────────────────────────────────
 * Runs the primary payment workflow (create → sign → submit → status → refund)
 * against the deterministic sandbox adapter with **no credentials, no network
 * and no database**. This is the fastest way to confirm sandbox mode works on
 * your machine.
 *
 * Usage:
 *   npm run sandbox:demo
 *
 * It never mutates any real state — every response comes from
 * `src/sandbox/fixtures/sandbox-fixtures.ts`.
 */

import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { SandboxPaymentAdapter } from "src/sandbox/adapters/sandbox-payment.adapter";
import { SandboxConfigService } from "src/sandbox/sandbox.config";
import { SandboxService } from "src/sandbox/sandbox.service";
import { SandboxScenario } from "src/sandbox/sandbox.scenarios";

/**
 * A ConfigService that exposes only SANDBOX_MODE — nothing else is configured,
 * which is the point: the sandbox must not need any production secret.
 */
function sandboxOnlyConfig(): ConfigService {
  const values: Record<string, string> = { SANDBOX_MODE: "true" };
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

async function main(): Promise<void> {
  const sandboxConfig = new SandboxConfigService(sandboxOnlyConfig());
  sandboxConfig.assertEnabled();

  const service = new SandboxService(
    sandboxConfig,
    new SandboxPaymentAdapter(sandboxConfig),
  );

  console.log("Sandbox configuration:\n");
  console.log(JSON.stringify(service.describe(), null, 2));

  const scenarios = [
    SandboxScenario.SUCCESS,
    SandboxScenario.INSUFFICIENT_FUNDS,
    SandboxScenario.HORIZON_TIMEOUT,
  ];

  for (const scenario of scenarios) {
    const result = await service.runPrimaryWorkflow({ scenario });
    console.log(`\nScenario "${scenario}" -> ok=${result.ok}`);
    console.log(JSON.stringify(result.steps, null, 2));
    if (result.error) {
      console.log(`error: ${result.error}`);
    }
  }
}

main().catch((error: Error) => {
  console.error(`sandbox demo failed: ${error.message}`);
  process.exit(1);
});
