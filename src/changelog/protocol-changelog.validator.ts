/**
 * Validation for the machine-readable protocol changelog.
 *
 * Two layers, because a JSON Schema cannot express the rules that matter most
 * for a changelog:
 *
 * 1. Structural validation against `changelog/schema/protocol-changes.schema.json`
 *    (required fields, types, enums, no unknown keys).
 * 2. Semantic rules: versions are unique and ordered, dates are real and not in
 *    the future, breaking changes carry a migration, deprecations name a
 *    replacement and a removal version, and every entry is traceable to an issue
 *    or pull request.
 *
 * The semantic layer takes an injected clock so validation is deterministic in
 * tests and reproducible in CI.
 *
 * Issue: #126
 */

import { readFileSync } from "fs";
import { isAbsolute, join } from "path";
// The schema is draft 2020-12, which needs Ajv's 2020 build rather than the
// draft-07 default export.
import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv";
import { PROTOCOL_CHANGELOG_SCHEMA_VERSION } from "./protocol-changelog.types";
import type {
  ProtocolChangeEntry,
  ProtocolChangelogDocument,
  ProtocolChangelogValidationResult,
  ProtocolChangelogViolation,
  ProtocolSurface,
} from "./protocol-changelog.types";

export const PROTOCOL_CHANGELOG_FILE = "changelog/protocol-changes.json";
export const PROTOCOL_CHANGELOG_SCHEMA_FILE =
  "changelog/schema/protocol-changes.schema.json";

/** Repository root, resolved from this file rather than `process.cwd()`. */
const REPO_ROOT = join(__dirname, "..", "..");

/** Releases move fast; allow a day of clock skew before calling a date a lie. */
const FUTURE_DATE_TOLERANCE_DAYS = 1;

const SURFACE_KEY_REQUIRED: ProtocolSurface["kind"][] = [
  "http",
  "websocket",
  "graphql",
];

function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: true,
    // `format` is intentionally unused in the schema: patterns plus explicit
    // semantic checks give better messages and avoid an extra dependency.
    validateFormats: false,
  });
}

let cachedSchema: object | undefined;
let cachedValidator: ValidateFunction | undefined;

function loadSchema(): object {
  if (cachedSchema === undefined) {
    cachedSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, PROTOCOL_CHANGELOG_SCHEMA_FILE), "utf8"),
    ) as object;
  }
  return cachedSchema;
}

/** Compiling the schema is the expensive part; the result is reused. */
function loadValidator(): ValidateFunction {
  cachedValidator ??= createAjv().compile(loadSchema());
  return cachedValidator;
}

function parseSemver(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
} | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // A release outranks any prerelease of the same version.
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** True for a real calendar date, e.g. rejects 2026-02-30. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Days from `now` until the given date; negative once the date is past. */
function daysUntil(fromIso: string, now: Date): number {
  const [year, month, day] = fromIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(year, month - 1, day) - startOfUtcDay(now)) / 86_400_000,
  );
}

function surfaceIdentity(surface: ProtocolSurface): string {
  return [
    surface.kind,
    surface.method ?? "",
    surface.path ?? surface.key ?? "",
  ].join(" ");
}

function validateEntry(
  entry: ProtocolChangeEntry,
  index: number,
  now: Date,
  violations: ProtocolChangelogViolation[],
): void {
  const pointer = `/entries/${index}`;

  if (!isCalendarDate(entry.date)) {
    violations.push({
      pointer: `${pointer}/date`,
      rule: "date-not-a-calendar-date",
      message: `date "${entry.date}" is not a real YYYY-MM-DD calendar date`,
    });
  } else if (daysUntil(entry.date, now) > FUTURE_DATE_TOLERANCE_DAYS) {
    violations.push({
      pointer: `${pointer}/date`,
      rule: "date-in-the-future",
      message: `date "${entry.date}" is in the future; an unreleased entry must use the date it is expected to ship or be marked with status "unreleased"`,
    });
  }

  const breakingChanges = entry.breakingChanges ?? [];
  if (entry.impact === "breaking" && breakingChanges.length === 0) {
    violations.push({
      pointer: `${pointer}/breakingChanges`,
      rule: "breaking-without-description",
      message: `impact "breaking" requires at least one breakingChanges entry describing what breaks`,
    });
  }

  if (entry.impact === "breaking" && !entry.migration?.required) {
    violations.push({
      pointer: `${pointer}/migration/required`,
      rule: "breaking-without-migration",
      message: `impact "breaking" requires migration.required to be true`,
    });
  }

  if (entry.migration?.required && entry.migration.steps.length === 0) {
    violations.push({
      pointer: `${pointer}/migration/steps`,
      rule: "migration-without-steps",
      message: `migration.required is true but migration.steps is empty`,
    });
  }

  for (const [stepIndex, step] of (entry.migration?.steps ?? []).entries()) {
    if (!step.trim().endsWith(".")) {
      violations.push({
        pointer: `${pointer}/migration/steps/${stepIndex}`,
        rule: "migration-step-not-actionable",
        message: `migration step "${step}" should be a complete, imperative sentence`,
      });
    }
  }

  for (const [surfaceIndex, surface] of entry.protocolSurfaces.entries()) {
    const surfacePointer = `${pointer}/protocolSurfaces/${surfaceIndex}`;
    if (
      SURFACE_KEY_REQUIRED.includes(surface.kind) &&
      !surface.path
    ) {
      violations.push({
        pointer: `${surfacePointer}/path`,
        rule: "surface-without-path",
        message: `a ${surface.kind} surface must name its path`,
      });
    }
    if (surface.kind === "config" && !surface.key) {
      violations.push({
        pointer: `${surfacePointer}/key`,
        rule: "surface-without-key",
        message: `a config surface must name its key or environment variable`,
      });
    }
    if (surface.kind === "http" && !surface.method) {
      violations.push({
        pointer: `${surfacePointer}/method`,
        rule: "http-surface-without-method",
        message: `an http surface must name its method`,
      });
    }
  }

  const seen = new Set<string>();
  for (const [surfaceIndex, surface] of entry.protocolSurfaces.entries()) {
    const identity = surfaceIdentity(surface);
    if (seen.has(identity)) {
      violations.push({
        pointer: `${pointer}/protocolSurfaces/${surfaceIndex}`,
        rule: "duplicate-surface",
        message: `surface "${identity}" is listed twice in the same entry`,
      });
    }
    seen.add(identity);
  }

  for (const [deprecationIndex, deprecation] of (
    entry.deprecations ?? []
  ).entries()) {
    const deprecationPointer = `${pointer}/deprecations/${deprecationIndex}`;
    if (compareSemver(deprecation.removalVersion, entry.version) <= 0) {
      violations.push({
        pointer: `${deprecationPointer}/removalVersion`,
        rule: "deprecation-removal-not-after-version",
        message: `removalVersion "${deprecation.removalVersion}" must be greater than the entry version "${entry.version}"`,
      });
    }
    if (
      entry.impact !== "deprecation" &&
      entry.impact !== "breaking"
    ) {
      violations.push({
        pointer: `${deprecationPointer}`,
        rule: "deprecation-without-impact",
        message: `an entry with deprecations must declare impact "deprecation" or "breaking", not "${entry.impact}"`,
      });
    }
  }

  const issues = entry.relatedIssues ?? [];
  const pullRequests = entry.relatedPullRequests ?? [];
  if (issues.length === 0 && pullRequests.length === 0) {
    violations.push({
      pointer: `${pointer}/relatedIssues`,
      rule: "untraceable-entry",
      message: `every entry must reference at least one relatedIssues or relatedPullRequests number`,
    });
  }
}

export function validateProtocolChangelog(
  document: unknown,
  now: Date = new Date(),
): ProtocolChangelogValidationResult {
  const violations: ProtocolChangelogViolation[] = [];
  const validate = loadValidator();

  if (!validate(document)) {
    for (const error of (validate.errors ?? []) as ErrorObject[]) {
      violations.push({
        pointer: error.instancePath || "/",
        rule: error.keyword,
        message: `${error.instancePath || "/"} ${error.message ?? "is invalid"}${
          error.keyword === "additionalProperties"
            ? ` (${String(
                (error.params as { additionalProperty?: string })
                  .additionalProperty,
              )})`
            : ""
        }`,
      });
    }
    // Semantic checks would only produce noise on a structurally broken file.
    return { valid: false, violations };
  }

  const changelog = document as ProtocolChangelogDocument;

  if (changelog.schemaVersion !== PROTOCOL_CHANGELOG_SCHEMA_VERSION) {
    violations.push({
      pointer: "/schemaVersion",
      rule: "unsupported-schema-version",
      message: `schemaVersion "${changelog.schemaVersion}" is not supported by this build (expected ${PROTOCOL_CHANGELOG_SCHEMA_VERSION})`,
    });
  }

  const seenEntries = new Set<string>();
  for (const [index, entry] of changelog.entries.entries()) {
    // One release may carry several entries; an identical one is a mistake.
    const identity = `${entry.version}\u0000${entry.title}`;
    if (seenEntries.has(identity)) {
      violations.push({
        pointer: `/entries/${index}/title`,
        rule: "duplicate-entry",
        message: `version "${entry.version}" already has an entry titled "${entry.title}"`,
      });
    }
    seenEntries.add(identity);
    validateEntry(entry, index, now, violations);
  }

  for (let index = 1; index < changelog.entries.length; index += 1) {
    const previous = changelog.entries[index - 1];
    const current = changelog.entries[index];
    if (compareSemver(previous.version, current.version) < 0) {
      violations.push({
        pointer: `/entries/${index}/version`,
        rule: "entries-out-of-order",
        message: `entries must be ordered newest first: "${current.version}" must not follow "${previous.version}"`,
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

export function resolveChangelogPath(
  override?: string,
  cwd: string = REPO_ROOT,
): string {
  if (!override) return join(cwd, PROTOCOL_CHANGELOG_FILE);
  return isAbsolute(override) ? override : join(cwd, override);
}

export interface LoadedProtocolChangelog {
  path: string;
  document: ProtocolChangelogDocument;
}

/**
 * Reads and validates the changelog. Throws on unreadable or invalid JSON so a
 * broken file fails loudly at start-up instead of being served as an empty
 * changelog.
 */
export function loadProtocolChangelog(
  options: { path?: string; now?: Date } = {},
): LoadedProtocolChangelog {
  const path = resolveChangelogPath(options.path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read the protocol changelog at ${path}: ${
        (error as Error).message
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `The protocol changelog at ${path} is not valid JSON: ${
        (error as Error).message
      }`,
    );
  }

  const result = validateProtocolChangelog(parsed, options.now);
  if (!result.valid) {
    const details = result.violations
      .map((violation) => `  - [${violation.rule}] ${violation.pointer} ${violation.message}`)
      .join("\n");
    throw new Error(
      `The protocol changelog at ${path} is invalid:\n${details}`,
    );
  }

  return { path, document: parsed as ProtocolChangelogDocument };
}
