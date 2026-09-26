/**
 * Schema versioning metadata and compatibility utilities.
 *
 * The versioning strategy uses NestJS URI-based versioning: routes are
 * accessible under /api/v1/... (current) and /api/v2/... (next, opt-in).
 * Legacy record schemas are transformed transparently on read so old clients
 * continue to receive the shape they expect.
 *
 * Issue: #64
 */

import * as semver from "semver";

/** Supported API schema versions */
export const API_VERSION_CURRENT = "1";
export const API_VERSION_NEXT = "2";
export const SUPPORTED_VERSIONS = [API_VERSION_CURRENT, API_VERSION_NEXT] as const;
export type ApiVersion = (typeof SUPPORTED_VERSIONS)[number];

/** Well-known record schema versions for persistent data */
export const RECORD_SCHEMA_VERSION_CURRENT = "1.0.0";

/**
 * Attach this metadata to any persisted DTO / entity that needs
 * schema version tracking.
 */
export interface VersionedRecord {
  /** Semver version of the record schema when it was written. */
  schemaVersion: string;
}

/**
 * Check whether a stored record's schemaVersion is compatible with
 * the requested version range.
 *
 * @param record     A persisted record that carries a `schemaVersion` field.
 * @param versionRange A semver range string, e.g. "^1.0.0" or ">=1.0.0 <2.0.0"
 * @returns true if `record.schemaVersion` satisfies the range.
 */
export function isSchemaCompatible(
  record: VersionedRecord,
  versionRange: string,
): boolean {
  try {
    return semver.satisfies(record.schemaVersion, versionRange);
  } catch {
    return false;
  }
}

/**
 * Stamp a freshly written record with the current schema version.
 * Returns the record merged with `{ schemaVersion: RECORD_SCHEMA_VERSION_CURRENT }`.
 */
export function stampSchemaVersion<T extends object>(
  record: T,
  version = RECORD_SCHEMA_VERSION_CURRENT,
): T & VersionedRecord {
  return { ...record, schemaVersion: version };
}

/**
 * Parse the API version from a versioned URL path (e.g. "/api/v1/users" → "1").
 * Returns the current version if parsing fails.
 */
export function parseVersionFromPath(path: string): ApiVersion {
  const match = /\/api\/v(\d+)\//.exec(path);
  if (!match) return API_VERSION_CURRENT;
  const v = match[1] as ApiVersion;
  return (SUPPORTED_VERSIONS as readonly string[]).includes(v)
    ? v
    : API_VERSION_CURRENT;
}
