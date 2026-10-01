import { HttpStatus } from "@nestjs/common";
import { AppException } from "./app.exception";
import { ErrorCode } from "./error-codes";

/**
 * Turns a database driver failure into a safe, actionable API error (issue #97).
 *
 * A `QueryFailedError` carries the driver's own text, and that text is written
 * for a database administrator, not for an API client:
 *
 *   duplicate key value violates unique constraint "users_email_key"
 *   insert into "audit_logs" ("accountId", "details") values (...) violates
 *   foreign key constraint "FK_1234" on table "invoices"
 *   invalid input syntax for type uuid: "not-a-uuid"
 *
 * Forwarding any of that hands an attacker the table and column inventory, the
 * constraint names, the exact failing statement, and — in the `22P02` case — a
 * value the caller should not have been able to make the server echo. So every
 * rule below states the *class* of failure in product language and the raw
 * driver error is left to the server-side log, where it belongs.
 */

/** Client-facing text for a class of database failure. */
export interface DatabaseErrorRule {
  /** SQLSTATE (Postgres) or the driver's own numeric/string error code. */
  code: string;
  status: HttpStatus;
  errorCode: ErrorCode;
  message: string;
  recoveryGuidance: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

/**
 * The response for a constraint failure we do not have a specific rule for.
 * 500 rather than 400: a constraint nobody anticipated is a defect on our side,
 * and the client is not in a position to fix it by changing the request.
 */
export const UNMAPPED_DATABASE_ERROR: Omit<DatabaseErrorRule, "code"> = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  errorCode: ErrorCode.DATABASE_ERROR,
  message: "The request could not be completed because of a database error",
  recoveryGuidance:
    "Please quote the correlationId when contacting support so the failure can be traced.",
};

/**
 * SQLSTATE codes, grouped by what the caller can do about them. The message
 * column is the only thing a client ever sees; it names no table, column,
 * constraint or value.
 */
export const DATABASE_ERROR_RULES: Record<string, DatabaseErrorRule> = {
  // ── Uniqueness: the caller retried something that already exists ────────
  "23505": {
    code: "23505",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.DUPLICATE_ENTRY,
    message: "A record with this identifier already exists",
    recoveryGuidance:
      "Choose a different identifier, or retrieve the existing record and update it instead of creating a second one.",
  },
  "23510": {
    code: "23510",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.DUPLICATE_ENTRY,
    message: "A record with these details already exists",
    recoveryGuidance:
      "This record is already present. Retrieve it and update it rather than creating a duplicate.",
  },

  // ── Referential integrity: the request points at something absent ───────
  "23503": {
    code: "23503",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A referenced record does not exist",
    recoveryGuidance:
      "Verify that every identifier in the request refers to a record that exists and is visible to this account.",
  },
  "23502": {
    code: "23502",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A required value was missing",
    recoveryGuidance:
      "Supply every mandatory field; the request was rejected because one of them was absent.",
  },
  "23514": {
    code: "23514",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A supplied value is not allowed",
    recoveryGuidance:
      "One of the supplied values falls outside the range this field accepts. Check it against the API schema.",
  },
  "22P02": {
    code: "22P02",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.INVALID_PARAMETER,
    message: "A supplied value has an invalid format",
    recoveryGuidance:
      "Check the format of the identifiers and enum values in the request against the API schema.",
  },
  "22001": {
    code: "22001",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A supplied value is too long for the field it targets",
    recoveryGuidance: "Shorten the value and retry.",
  },
  "22003": {
    code: "22003",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A supplied number is outside the allowed range",
    recoveryGuidance: "Supply a value within the range this field accepts and retry.",
  },
  "22007": {
    code: "22007",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A supplied value is outside the allowed range",
    recoveryGuidance: "Supply a value within the range this field accepts and retry.",
  },

  // ── Concurrency: the same work is safe to retry ─────────────────────────
  "40001": {
    code: "40001",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.CONFLICT,
    message: "The request conflicted with a concurrent one and was rolled back",
    recoveryGuidance: "Retry the request; no changes were committed.",
    retryable: true,
    retryAfterSeconds: 1,
  },
  "40P01": {
    code: "40P01",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.CONFLICT,
    message: "The request deadlocked against another transaction",
    recoveryGuidance: "Retry the request; no changes were committed.",
    retryable: true,
    retryAfterSeconds: 1,
  },
  "55P03": {
    code: "55P03",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.CONFLICT,
    message: "The record is being modified by another request",
    recoveryGuidance: "Retry shortly once the concurrent update completes.",
    retryable: true,
    retryAfterSeconds: 2,
  },

  // ── Availability ────────────────────────────────────────────────────────
  "53300": {
    code: "53300",
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    message: "The service is temporarily at capacity",
    recoveryGuidance: "Retry with exponential backoff.",
    retryable: true,
    retryAfterSeconds: 5,
  },
  "53400": {
    code: "53400",
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    message: "The service is temporarily at capacity",
    recoveryGuidance: "Retry with exponential backoff.",
    retryable: true,
    retryAfterSeconds: 5,
  },
  "57P01": {
    code: "57P01",
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    message: "The service is shutting down for maintenance",
    recoveryGuidance: "Retry once the deployment has completed.",
    retryable: true,
    retryAfterSeconds: 30,
  },
  "57014": {
    code: "57014",
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: ErrorCode.DEPENDENCY_TIMEOUT,
    message: "The request took too long and was cancelled",
    recoveryGuidance:
      "Narrow the request (fewer records, a shorter date range) and try again.",
    retryable: true,
    retryAfterSeconds: 5,
  },
  // Class 08 — connection exceptions.
  "08000": availabilityRule("08000"),
  "08001": availabilityRule("08001"),
  "08003": availabilityRule("08003"),
  "08004": availabilityRule("08004"),
  "08006": availabilityRule("08006"),
  "08007": availabilityRule("08007"),
  "08P01": availabilityRule("08P01"),

  // ── Schema-level faults: our defect, and never the client's ─────────────
  "42P01": schemaFault("42P01"),
  "42703": schemaFault("42703"),
  "42704": schemaFault("42704"),
  "42883": schemaFault("42883"),
  "42P20": schemaFault("42P20"),
  "25006": schemaFault("25006"),

  // ── Other supported drivers ─────────────────────────────────────────────
  // The API runs on Postgres, but the same classes of failure arrive under a
  // different code when a test or an edge deployment runs on SQLite/MySQL, and
  // they leak exactly as much.
  SQLITE_CONSTRAINT: {
    code: "SQLITE_CONSTRAINT",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.DUPLICATE_ENTRY,
    message: "A record with this identifier already exists",
    recoveryGuidance:
      "Choose a different identifier, or retrieve the existing record and update it instead of creating a second one.",
  },
  SQLITE_CONSTRAINT_UNIQUE: uniqueRule("SQLITE_CONSTRAINT_UNIQUE"),
  SQLITE_CONSTRAINT_PRIMARYKEY: uniqueRule("SQLITE_CONSTRAINT_PRIMARYKEY"),
  SQLITE_BUSY: availabilityRule("SQLITE_BUSY"),
  ER_DUP_ENTRY: uniqueRule("ER_DUP_ENTRY"),
  ER_NO_REFERENCED_ROW_2: {
    code: "ER_NO_REFERENCED_ROW_2",
    status: HttpStatus.BAD_REQUEST,
    errorCode: ErrorCode.VALIDATION_ERROR,
    message: "A referenced record does not exist",
    recoveryGuidance:
      "Verify that every identifier in the request refers to a record that exists and is visible to this account.",
  },
  ER_ROW_IS_REFERENCED_2: {
    code: "ER_ROW_IS_REFERENCED_2",
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.CONFLICT,
    message: "This record is still referenced by other records",
    recoveryGuidance:
      "Remove the records that depend on this one, or deactivate it instead of deleting it.",
  },

  // Socket-level failures: node-postgres surfaces these without a SQLSTATE.
  ECONNREFUSED: availabilityRule("ECONNREFUSED"),
  ECONNRESET: availabilityRule("ECONNRESET"),
  EHOSTUNREACH: availabilityRule("EHOSTUNREACH"),
  ENETUNREACH: availabilityRule("ENETUNREACH"),
  ENOTFOUND: availabilityRule("ENOTFOUND"),
  EPIPE: availabilityRule("EPIPE"),
  ETIMEDOUT: availabilityRule("ETIMEDOUT"),
  EAI_AGAIN: availabilityRule("EAI_AGAIN"),
};

function availabilityRule(code: string): DatabaseErrorRule {
  return {
    code,
    status: HttpStatus.SERVICE_UNAVAILABLE,
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    message: "The service is temporarily unable to reach its datastore",
    recoveryGuidance: "Retry with exponential backoff.",
    retryable: true,
    retryAfterSeconds: 5,
  };
}

function schemaFault(code: string): DatabaseErrorRule {
  return {
    code,
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode: ErrorCode.DATABASE_ERROR,
    message: UNMAPPED_DATABASE_ERROR.message,
    recoveryGuidance: UNMAPPED_DATABASE_ERROR.recoveryGuidance,
  };
}

function uniqueRule(code: string): DatabaseErrorRule {
  return {
    code,
    status: HttpStatus.CONFLICT,
    errorCode: ErrorCode.DUPLICATE_ENTRY,
    message: "A record with this identifier already exists",
    recoveryGuidance:
      "Choose a different identifier, or retrieve the existing record and update it instead of creating a second one.",
  };
}

/** How deep to walk wrapper errors looking for the driver's own code. */
const MAX_DRIVER_ERROR_DEPTH = 5;

interface DriverErrorCarrier {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  driverError?: unknown;
  cause?: unknown;
  originalError?: unknown;
  parent?: unknown;
}

/**
 * Find the driver's error code on an exception and everything it wraps.
 *
 * The shape differs by stack: TypeORM's `QueryFailedError` puts the pg error on
 * `.driverError`, a repository may add `.cause`, and node-postgres itself
 * throws the `DatabaseError` directly. Walking the chain means the mapping does
 * not depend on which layer let the error escape.
 */
export function extractDatabaseErrorCode(exception: unknown): string | null {
  let current: unknown = exception;

  for (let depth = 0; depth < MAX_DRIVER_ERROR_DEPTH && current; depth++) {
    if (typeof current !== "object") return null;
    const candidate = current as DriverErrorCarrier;
    if (typeof candidate.code === "string" && candidate.code) {
      return candidate.code;
    }
    current = candidate.driverError ?? candidate.cause ?? candidate.originalError ?? candidate.parent;
  }

  return null;
}

/**
 * Whether the exception came out of the database driver, by code *or* by type
 * name. The name check catches a driver error that reports a code this module
 * has no rule for, which must still be sanitised rather than leaked.
 */
export function isDatabaseError(exception: unknown): boolean {
  let current: unknown = exception;

  for (let depth = 0; depth < MAX_DRIVER_ERROR_DEPTH && current; depth++) {
    if (typeof current !== "object") return false;
    const candidate = current as DriverErrorCarrier;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    if (
      name === "QueryFailedError" ||
      name === "DatabaseError" ||
      name === "EntityNotFoundError" ||
      extractDatabaseErrorCode(candidate) !== null
    ) {
      return true;
    }
    current = candidate.driverError ?? candidate.cause ?? candidate.originalError ?? candidate.parent;
  }

  return false;
}

/**
 * TypeORM's "row was expected but absent". Its message names the entity class,
 * so it is mapped here too rather than falling through as a 500 that leaks the
 * schema.
 */
function isEntityNotFound(exception: unknown): boolean {
  let current: unknown = exception;
  for (let depth = 0; depth < MAX_DRIVER_ERROR_DEPTH && current; depth++) {
    if (typeof current !== "object") return false;
    if ((current as DriverErrorCarrier).name === "EntityNotFoundError") return true;
    const candidate = current as DriverErrorCarrier;
    current = candidate.driverError ?? candidate.cause ?? candidate.originalError ?? candidate.parent;
  }
  return false;
}

/**
 * Map a database failure to an `AppException`, or `null` when the exception did
 * not come from the database and should be handled by the caller's other
 * branches.
 */
export function mapDatabaseError(exception: unknown): AppException | null {
  if (!isDatabaseError(exception) && !isEntityNotFound(exception)) return null;

  if (isEntityNotFound(exception)) {
    return new AppException(
      "The requested record does not exist",
      HttpStatus.NOT_FOUND,
      ErrorCode.NOT_FOUND,
      {
        recoveryGuidance:
          "Verify the identifier in the request and that the record is visible to this account.",
      },
    );
  }

  const code = extractDatabaseErrorCode(exception);
  const rule = (code && DATABASE_ERROR_RULES[code]) || UNMAPPED_DATABASE_ERROR;

  return new AppException(rule.message, rule.status, rule.errorCode, {
    ...(rule.retryable !== undefined && { retryable: rule.retryable }),
    ...(rule.retryAfterSeconds !== undefined && {
      retryAfterSeconds: rule.retryAfterSeconds,
    }),
    recoveryGuidance: rule.recoveryGuidance,
  });
}
