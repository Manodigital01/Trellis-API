import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from "@nestjs/common";
import { SemanticValidatorService } from "./semantic-validator.service";

/**
 * Configuration for a semantic validation rule.
 */
export interface SemanticValidationRule {
  /**
   * The name of the rule (for logging and error identification).
   */
  name: string;

  /**
   * Validation function that returns true if valid, false if invalid.
   * Receives the DTO payload and can inspect any fields.
   */
  validate: (payload: any) => boolean | Promise<boolean>;

  /**
   * Error message to display if validation fails.
   */
  errorMessage: string;

  /**
   * Error code (from SemanticValidationErrorCode or custom).
   */
  errorCode?: string;

  /**
   * Field name(s) involved in the validation, for error reporting.
   */
  affectedFields?: string[];

  /**
   * Additional context to include in the error response.
   */
  context?: Record<string, unknown>;
}

/**
 * Decorator for applying semantic validation rules to NestJS controller methods.
 *
 * @example
 *   @Post()
 *   @SemanticValidate([
 *     {
 *       name: 'date_range_valid',
 *       validate: (dto) => new Date(dto.startDate) <= new Date(dto.endDate),
 *       errorMessage: 'Start date must be before end date',
 *       errorCode: 'ERR_INVALID_DATE_RANGE',
 *       affectedFields: ['startDate', 'endDate'],
 *     },
 *   ])
 *   async create(@Body() dto: CreateDto) { ... }
 */
export const SemanticValidate = (rules: SemanticValidationRule[]) => {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const req = args.find((arg) => arg && typeof arg === "object" && "body" in arg);
      const body = req?.body;

      if (body && rules && rules.length > 0) {
        for (const rule of rules) {
          try {
            const isValid = await rule.validate(body);

            if (!isValid) {
              throw new BadRequestException({
                statusCode: 400,
                error: "Bad Request",
                message: rule.errorCode || "Validation failed",
                errors: [
                  {
                    code: rule.errorCode || "ERR_SEMANTIC_VALIDATION_FAILED",
                    field: rule.affectedFields?.join(" | ") || "unknown",
                    constraints: {
                      [rule.name]: rule.errorMessage,
                    },
                    context: rule.context,
                  },
                ],
              });
            }
          } catch (err) {
            if (err instanceof BadRequestException) {
              throw err;
            }
            throw new BadRequestException({
              statusCode: 400,
              error: "Bad Request",
              message: "Validation error",
              errors: [
                {
                  code: "ERR_VALIDATION_ERROR",
                  field: rule.affectedFields?.join(" | ") || "unknown",
                  constraints: {
                    [rule.name]: err instanceof Error ? err.message : String(err),
                  },
                },
              ],
            });
          }
        }
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
};
