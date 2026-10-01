/**
 * Read model for the machine-readable protocol changelog.
 *
 * Loads and validates the changelog once per process, then answers filtered
 * queries. A client that pins its own version can ask for everything newer and
 * learn whether it must act.
 *
 * Issue: #126
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isAbsolute, join } from "path";
import { readFileSync } from "fs";
import {
  loadProtocolChangelog,
  resolveChangelogPath,
  validateProtocolChangelog,
} from "./protocol-changelog.validator";
import type {
  ProtocolChangeEntry,
  ProtocolChangeImpact,
  ProtocolChangelogDocument,
  ProtocolChangelogValidationResult,
} from "./protocol-changelog.types";
import { PROTOCOL_CHANGELOG_SCHEMA_VERSION } from "./protocol-changelog.types";

export interface ProtocolChangelogQuery {
  /** Only entries whose version is strictly greater than this one. */
  since?: string;
  /** Restrict to specific impact levels. */
  impact?: ProtocolChangeImpact[];
  /** Restrict to a release status. */
  status?: "released" | "unreleased";
}

export interface ProtocolChangelogView {
  schemaVersion: string;
  project: string;
  generatedAt: string;
  /** Every entry matching the query, newest first. */
  entries: ProtocolChangeEntry[];
  /** Highest version in the whole document, regardless of the query. */
  latestVersion: string | null;
  /** Worst impact in the returned set, or null when nothing matched. */
  highestImpact: ProtocolChangeImpact | null;
  /** True when at least one returned entry requires the caller to act. */
  migrationRequired: boolean;
  /** Paths that matched the filters, for quick operator triage. */
  affectedPaths: string[];
}

const IMPACT_ORDER: ProtocolChangeImpact[] = [
  "breaking",
  "security",
  "deprecation",
  "compatible",
  "fix",
];

@Injectable()
export class ProtocolChangelogService implements OnModuleInit {
  private readonly logger = new Logger(ProtocolChangelogService.name);
  private document: ProtocolChangelogDocument | null = null;
  private loadedAt: Date | null = null;

  constructor(private readonly configService?: ConfigService) {}

  onModuleInit(): void {
    try {
      this.load();
    } catch (error) {
      // A broken changelog must not take the whole API down, but it must be
      // impossible to miss.
      this.logger.error((error as Error).message);
    }
  }

  private resolvePath(): string {
    const override = this.configService?.get<string>("CHANGELOG_PATH");
    const root = join(__dirname, "..", "..");
    if (!override) return resolveChangelogPath(undefined, root);
    return isAbsolute(override) ? override : join(root, override);
  }

  private load(): ProtocolChangelogDocument {
    const path = this.resolvePath();
    const loaded = loadProtocolChangelog({ path });
    this.document = loaded.document;
    this.loadedAt = new Date();
    this.logger.log(
      `Loaded ${loaded.document.entries.length} protocol changelog entries from ${path}`,
    );
    return loaded.document;
  }

  /** Returns the changelog, loading it on first use. */
  getDocument(): ProtocolChangelogDocument {
    return this.document ?? this.load();
  }

  /** Exposed so the validator script and the API share one code path. */
  validate(now: Date = new Date()): ProtocolChangelogValidationResult {
    const raw = readFileSync(this.resolvePath(), "utf8");
    return validateProtocolChangelog(JSON.parse(raw), now);
  }

  /** Raw JSON Schema served to tooling that wants to validate our output. */
  getSchema(): unknown {
    return JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "changelog", "schema", "protocol-changes.schema.json"),
        "utf8",
      ),
    );
  }

  query(query: ProtocolChangelogQuery = {}): ProtocolChangelogView {
    const document = this.getDocument();
    const all = [...document.entries].sort((a, b) =>
      a.version === b.version
        ? a.date < b.date
          ? 1
          : -1
        : compareVersionsDesc(a.version, b.version),
    );

    const matches = all.filter((entry) => {
      if (query.status && entry.status !== query.status) return false;
      if (query.impact && !query.impact.includes(entry.impact)) return false;
      if (query.since && compareVersions(entry.version, query.since) <= 0) {
        return false;
      }
      return true;
    });

    // IMPACT_ORDER runs from worst to best, so the lowest index wins.
    const highestImpact = matches.reduce<ProtocolChangeImpact | null>(
      (worst, entry) => {
        if (worst === null) return entry.impact;
        return IMPACT_ORDER.indexOf(entry.impact) < IMPACT_ORDER.indexOf(worst)
          ? entry.impact
          : worst;
      },
      null,
    );

    return {
      schemaVersion: PROTOCOL_CHANGELOG_SCHEMA_VERSION,
      project: document.project,
      generatedAt: this.loadedAt?.toISOString() ?? new Date().toISOString(),
      entries: matches,
      latestVersion: all[0]?.version ?? null,
      highestImpact,
      migrationRequired: matches.some(
        (entry) => entry.migration.required || entry.impact === "breaking",
      ),
      affectedPaths: [
        ...new Set(
          matches.flatMap((entry) =>
            entry.protocolSurfaces
              .map((surface) => surface.path ?? surface.key)
              .filter((value): value is string => Boolean(value)),
          ),
        ),
      ].sort(),
    };
  }
}

function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Returns a negative number when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function compareVersionsDesc(a: string, b: string): number {
  return compareVersions(b, a);
}
