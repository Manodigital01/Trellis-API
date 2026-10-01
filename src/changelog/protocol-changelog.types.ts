/**
 * Types for the machine-readable protocol changelog.
 *
 * The runtime shape is enforced by `changelog/schema/protocol-changes.schema.json`;
 * these types describe the same contract for TypeScript consumers.
 *
 * Issue: #126
 */

export const PROTOCOL_CHANGELOG_SCHEMA_VERSION = "1.0.0";

export const PROTOCOL_CHANGE_IMPACTS = [
  "breaking",
  "deprecation",
  "compatible",
  "fix",
  "security",
] as const;

export type ProtocolChangeImpact = (typeof PROTOCOL_CHANGE_IMPACTS)[number];

export const PROTOCOL_SURFACE_KINDS = [
  "http",
  "websocket",
  "graphql",
  "event",
  "config",
  "cli",
  "database",
] as const;

export type ProtocolSurfaceKind = (typeof PROTOCOL_SURFACE_KINDS)[number];

export interface ProtocolSurface {
  kind: ProtocolSurfaceKind;
  method?: string;
  path?: string;
  key?: string;
  description: string;
}

export interface ProtocolMigration {
  required: boolean;
  automated: boolean;
  steps: string[];
  notes: string;
}

export interface ProtocolBreakingChange {
  description: string;
  replacement?: string;
  issue?: number;
}

export interface ProtocolDeprecation {
  surface: string;
  replacement: string;
  removalVersion: string;
}

export interface ProtocolChangeEntry {
  version: string;
  date: string;
  status: "released" | "unreleased";
  impact: ProtocolChangeImpact;
  title: string;
  summary: string;
  protocolSurfaces: ProtocolSurface[];
  migration: ProtocolMigration;
  breakingChanges?: ProtocolBreakingChange[];
  deprecations?: ProtocolDeprecation[];
  relatedIssues?: number[];
  relatedPullRequests?: number[];
  docs?: string[];
}

export interface ProtocolChangelogDocument {
  $schema?: string;
  schemaVersion: string;
  project: string;
  generatedAt?: string;
  entries: ProtocolChangeEntry[];
}

/** A single rule violation, addressed by JSON pointer where possible. */
export interface ProtocolChangelogViolation {
  /** JSON pointer into the document, e.g. `/entries/0/impact`. */
  pointer: string;
  /** Machine-readable rule identifier, e.g. `breaking-without-migration`. */
  rule: string;
  message: string;
}

export interface ProtocolChangelogValidationResult {
  valid: boolean;
  violations: ProtocolChangelogViolation[];
}
