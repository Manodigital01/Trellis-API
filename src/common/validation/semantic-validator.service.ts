import { Injectable, BadRequestException } from "@nestjs/common";
import { logger } from "../../config/logger";

/**
 * Stable error codes for semantic validation failures.
 * Used to identify business-rule violations without leaking internals.
 */
export enum SemanticValidationErrorCode {
  INSUFFICIENT_BALANCE = "ERR_INSUFFICIENT_BALANCE",
  INVALID_DATE_RANGE = "ERR_INVALID_DATE_RANGE",
  CIRCULAR_REFERENCE = "ERR_CIRCULAR_REFERENCE",
  DUPLICATE_ENTRY = "ERR_DUPLICATE_ENTRY",
  INVALID_STATE_TRANSITION = "ERR_INVALID_STATE_TRANSITION",
  RATE_LIMIT_EXCEEDED = "ERR_RATE_LIMIT_EXCEEDED",
  CONCURRENT_OPERATION_CONFLICT = "ERR_CONCURRENT_OPERATION_CONFLICT",
  INVALID_COMBINATION = "ERR_INVALID_COMBINATION",
  PREREQUISITE_NOT_MET = "ERR_PREREQUISITE_NOT_MET",
  QUOTA_EXHAUSTED = "ERR_QUOTA_EXHAUSTED",
}

/**
 * Formatted semantic validation error.
 */
export interface SemanticValidationError {
  code: SemanticValidationErrorCode | string;
  field?: string;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Service for semantic validation of business rules that go beyond shape checks.
 *
 * Examples:
 * - Start date must be before end date
 * - Withdrawal amount cannot exceed available balance
 * - User cannot re-enable an already-active agent
 * - Portfolio rebalancing cannot happen during market hours
 *
 * All validation methods throw BadRequestException with structured error responses.
 */
@Injectable()
export class SemanticValidatorService {
  /**
   * Validate a date range (start <= end).
   * @throws BadRequestException if startDate > endDate
   */
  validateDateRange(
    startDate: Date | string,
    endDate: Date | string,
    fieldName = "dateRange",
  ): void {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid date format",
        errors: [
          {
            field: fieldName,
            constraints: {
              invalidDateFormat: "Start date or end date is not a valid date",
            },
          },
        ],
      });
    }

    if (start > end) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.INVALID_DATE_RANGE,
        errors: [
          {
            code: SemanticValidationErrorCode.INVALID_DATE_RANGE,
            field: fieldName,
            constraints: {
              dateRangeViolation: "Start date must be before or equal to end date",
            },
          },
        ],
      });
    }
  }

  /**
   * Validate that a numeric value does not exceed a maximum.
   * @throws BadRequestException if value > maximum
   */
  validateMaximum(
    value: number,
    maximum: number,
    fieldName = "value",
    context?: Record<string, unknown>,
  ): void {
    if (value > maximum) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.INVALID_COMBINATION,
        errors: [
          {
            code: SemanticValidationErrorCode.INVALID_COMBINATION,
            field: fieldName,
            constraints: {
              exceedsMaximum: `Value must not exceed ${maximum}`,
            },
            context: {
              value,
              maximum,
              ...context,
            },
          },
        ],
      });
    }
  }

  /**
   * Validate that a numeric value does not fall below a minimum.
   * @throws BadRequestException if value < minimum
   */
  validateMinimum(
    value: number,
    minimum: number,
    fieldName = "value",
    context?: Record<string, unknown>,
  ): void {
    if (value < minimum) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.INVALID_COMBINATION,
        errors: [
          {
            code: SemanticValidationErrorCode.INVALID_COMBINATION,
            field: fieldName,
            constraints: {
              belowMinimum: `Value must be at least ${minimum}`,
            },
            context: {
              value,
              minimum,
              ...context,
            },
          },
        ],
      });
    }
  }

  /**
   * Validate that an array does not contain duplicates.
   * @throws BadRequestException if duplicates are found
   */
  validateNoDuplicates<T>(
    items: T[],
    keyFn: (item: T) => string | number,
    fieldName = "items",
  ): void {
    const seen = new Set<string | number>();
    const duplicates: Array<string | number> = [];

    for (const item of items) {
      const key = keyFn(item);
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    if (duplicates.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.DUPLICATE_ENTRY,
        errors: [
          {
            code: SemanticValidationErrorCode.DUPLICATE_ENTRY,
            field: fieldName,
            constraints: {
              hasDuplicates: `Array contains duplicate entries`,
            },
            context: {
              duplicateCount: duplicates.length,
              duplicates: duplicates.slice(0, 10), // Limit to first 10
            },
          },
        ],
      });
    }
  }

  /**
   * Validate that a string matches a specific business rule pattern.
   * @throws BadRequestException if pattern validation fails
   */
  validateBusinessPattern(
    value: string,
    pattern: RegExp,
    fieldName = "field",
    description = "invalid format",
  ): void {
    if (!pattern.test(value)) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.INVALID_COMBINATION,
        errors: [
          {
            code: SemanticValidationErrorCode.INVALID_COMBINATION,
            field: fieldName,
            constraints: {
              patternMismatch: `Value does not match required business pattern: ${description}`,
            },
          },
        ],
      });
    }
  }

  /**
   * Validate that mutually exclusive fields are not both provided.
   * @throws BadRequestException if multiple exclusive fields are present
   */
  validateExclusive(
    obj: Record<string, unknown>,
    fieldNames: string[],
    context?: Record<string, unknown>,
  ): void {
    const providedFields = fieldNames.filter((f) => obj[f] !== undefined && obj[f] !== null);

    if (providedFields.length > 1) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.INVALID_COMBINATION,
        errors: [
          {
            code: SemanticValidationErrorCode.INVALID_COMBINATION,
            field: fieldNames.join(" | "),
            constraints: {
              mutuallyExclusive: `Only one of ${fieldNames.join(", ")} can be provided`,
            },
            context: {
              providedFields,
              ...context,
            },
          },
        ],
      });
    }
  }

  /**
   * Validate that at least one of the required fields is provided.
   * @throws BadRequestException if none of the required fields are present
   */
  validateAtLeastOne(
    obj: Record<string, unknown>,
    fieldNames: string[],
    context?: Record<string, unknown>,
  ): void {
    const providedFields = fieldNames.filter((f) => obj[f] !== undefined && obj[f] !== null);

    if (providedFields.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: SemanticValidationErrorCode.PREREQUISITE_NOT_MET,
        errors: [
          {
            code: SemanticValidationErrorCode.PREREQUISITE_NOT_MET,
            field: fieldNames.join(" | "),
            constraints: {
              missingRequired: `At least one of ${fieldNames.join(", ")} must be provided`,
            },
            context,
          },
        ],
      });
    }
  }

  /**
   * Validate a conditional requirement: if fieldA is present, fieldB is required.
   * @throws BadRequestException if the condition is violated
   */
  validateConditionalRequired(
    obj: Record<string, unknown>,
    conditionField: string,
    requiredWhenPresentFields: string[],
    context?: Record<string, unknown>,
  ): void {
    if (obj[conditionField] !== undefined && obj[conditionField] !== null) {
      const missingFields = requiredWhenPresentFields.filter(
        (f) => obj[f] === undefined || obj[f] === null,
      );

      if (missingFields.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: "Bad Request",
          message: SemanticValidationErrorCode.PREREQUISITE_NOT_MET,
          errors: [
            {
              code: SemanticValidationErrorCode.PREREQUISITE_NOT_MET,
              field: requiredWhenPresentFields.join(" | "),
              constraints: {
                conditionalRequired: `When ${conditionField} is provided, ${requiredWhenPresentFields.join(", ")} must also be provided`,
              },
              context: {
                conditionField,
                missingFields,
                ...context,
              },
            },
          ],
        });
      }
    }
  }

  /**
   * Log a semantic validation event (useful for debugging business-rule violations).
   */
  logValidationEvent(
    code: SemanticValidationErrorCode | string,
    details: Record<string, unknown>,
  ): void {
    logger.warn(
      { code, ...details },
      "Semantic validation event",
    );
  }
}
