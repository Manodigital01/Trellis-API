/**
 * Executes the dependency registry and turns the individual probe outcomes
 * into a sanitized {@link DependencyReport}.
 *
 * Kept free of NestJS so it can be reused by `scripts/dependency-health.ts`.
 *
 * Issue: #124
 */

import { DEPENDENCY_DEFINITIONS } from "./dependency-health.registry";
import {
  assertDependencyStates,
  buildConfigKeyReports,
  buildDependencyReport,
  errorMessage,
  pickRemediation,
  sanitizeDependencyMessage,
} from "./dependency-health.probe-kit";
import {
  DependencyCheckResult,
  DependencyDefinition,
  DependencyProbeContext,
  DependencyReport,
} from "./dependency-health.types";

export interface RunDependencyChecksOptions {
  context: DependencyProbeContext;
  /** Defaults to the full registry. */
  definitions?: DependencyDefinition[];
  /** Injectable clock so tests get stable timestamps and durations. */
  now?: () => number;
  /** Injectable date so tests get stable `generatedAt`. */
  isoNow?: () => string;
}

async function runOne(
  definition: DependencyDefinition,
  context: DependencyProbeContext,
): Promise<DependencyCheckResult> {
  let outcome;
  try {
    outcome = await definition.probe(context);
  } catch (error) {
    outcome = {
      state: "unavailable" as const,
      detail: `probe threw unexpectedly: ${errorMessage(error)}`,
      verification: "configuration" as const,
    };
  }

  const configKeys = buildConfigKeyReports(
    context,
    definition.configKeys,
    outcome.extraConfigKeys,
  );

  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    criticality: definition.criticality,
    state: outcome.state,
    detail: sanitizeDependencyMessage(outcome.detail, context.env),
    latencyMs: outcome.latencyMs,
    target: outcome.target,
    verification: outcome.verification ?? "configuration",
    configKeys,
    remediation: sanitizeDependencyMessage(
      pickRemediation(definition, outcome.state),
      context.env,
    ),
  };
}

/**
 * Runs every dependency check. Probes never reject: a throwing probe is
 * reported as `unavailable` so one broken dependency cannot mask the others.
 */
export async function runDependencyChecks(
  options: RunDependencyChecksOptions,
): Promise<DependencyReport> {
  const { context } = options;
  const definitions = options.definitions ?? DEPENDENCY_DEFINITIONS;
  const now = options.now ?? (() => Date.now());
  const isoNow = options.isoNow ?? (() => new Date().toISOString());

  const startedAt = now();
  const results = await Promise.all(
    definitions.map(async (definition) => ({
      definition,
      result: await runOne(definition, context),
    })),
  );

  assertDependencyStates(results);

  return buildDependencyReport(
    results.map((entry) => entry.result),
    now() - startedAt,
    !context.networkProbesEnabled,
    isoNow(),
  );
}
