import {
  ArgumentsHost,
  HttpStatus,
  Logger,
  BadRequestException as NestBadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EntityNotFoundError, QueryFailedError } from "typeorm";
import { GlobalExceptionFilter } from "./global-exception.filter";
import {
  SettlementFailedException,
  SettlementTimeoutException,
  InsufficientFundsException,
  UnauthorizedException,
  ForbiddenException,
} from "../errors/app.exception";
import { ErrorCode, ErrorDomain } from "../errors/error-codes";

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;
  let configService: ConfigService;
  let mockResponse: any;
  let mockRequest: any;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === "NODE_ENV") return "production";
        return null;
      }),
    } as unknown as ConfigService;

    filter = new GlobalExceptionFilter(configService);

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };

    mockRequest = {
      url: "/api/v1/stellar/settlement",
      method: "POST",
      headers: {},
      query: {},
      params: {},
      ip: "127.0.0.1",
    };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;
  });

  describe("Validation Errors", () => {
    it("renders structured validation error with domain and recovery guidance", () => {
      const validationError = new NestBadRequestException({
        message: ["amount must be a positive number", "recipient must be a valid address"],
        error: "Bad Request",
        statusCode: 400,
      });

      filter.catch(validationError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.VALIDATION_ERROR,
          domain: ErrorDomain.VALIDATION,
          message: "Validation failed",
          retryable: false,
          errors: {
            amount: ["amount must be a positive number"],
            recipient: ["recipient must be a valid address"],
          },
          recoveryGuidance: expect.stringContaining("Review the request body"),
          correlationId: expect.any(String),
          path: "/api/v1/stellar/settlement",
        }),
      );
    });
  });

  describe("Authorization & RBAC Errors", () => {
    it("renders unauthorized error with auth domain and login guidance", () => {
      filter.catch(new UnauthorizedException(), mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 401,
          errorCode: ErrorCode.UNAUTHORIZED,
          domain: ErrorDomain.AUTH,
          retryable: false,
          recoveryGuidance: expect.stringContaining("Bearer token"),
        }),
      );
    });

    it("renders forbidden error when permission check fails", () => {
      filter.catch(new ForbiddenException("Insufficient permissions"), mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          errorCode: ErrorCode.FORBIDDEN,
          domain: ErrorDomain.AUTH,
          retryable: false,
        }),
      );
    });
  });

  describe("Settlement & Payment Errors", () => {
    it("renders fatal settlement failure (non-retryable)", () => {
      filter.catch(
        new SettlementFailedException("Stellar sequence mismatch"),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.SETTLEMENT_FAILED,
          domain: ErrorDomain.SETTLEMENT,
          retryable: false,
          message: "Stellar sequence mismatch",
        }),
      );
    });

    it("renders settlement timeout with retryability and retryAfterSeconds metadata", () => {
      filter.catch(
        new SettlementTimeoutException(
          "Stellar Horizon did not confirm transaction",
          10,
        ),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.GATEWAY_TIMEOUT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 504,
          errorCode: ErrorCode.SETTLEMENT_TIMEOUT,
          domain: ErrorDomain.SETTLEMENT,
          retryable: true,
          retryAfterSeconds: 10,
          recoveryGuidance: expect.stringContaining("Verify transaction status"),
        }),
      );
    });

    it("renders insufficient funds error with funding guidance", () => {
      filter.catch(
        new InsufficientFundsException("Account lacks balance for 100 XLM"),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.INSUFFICIENT_FUNDS,
          domain: ErrorDomain.SETTLEMENT,
          retryable: false,
          recoveryGuidance: expect.stringContaining("Ensure the source wallet holds sufficient balance"),
        }),
      );
    });
  });

  describe("Database Errors (#97)", () => {
    /** node-postgres throws its own `DatabaseError`, named as such, with a SQLSTATE. */
    const pgError = (code: string, message: string) =>
      Object.assign(new Error(message), {
        name: "DatabaseError",
        code,
        severity: "ERROR",
      });

    const queryFailed = (code: string, message: string) =>
      new QueryFailedError(
        'INSERT INTO "accounts" ("email", "planId") VALUES ($1, $2)',
        ["victim@example.com", "growth"],
        pgError(code, message),
      );

    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    const payload = () => mockResponse.json.mock.calls[0][0];

    it("maps a unique violation (23505) to 409 without leaking the constraint or the value", () => {
      const exception = queryFailed(
        "23505",
        'duplicate key value violates unique constraint "accounts_email_key"',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 409,
          errorCode: ErrorCode.DUPLICATE_ENTRY,
          message: "A record with this identifier already exists",
          retryable: false,
          recoveryGuidance: expect.stringContaining("different identifier"),
          correlationId: expect.any(String),
        }),
      );

      const serialized = JSON.stringify(payload());
      expect(serialized).not.toContain("accounts_email_key");
      expect(serialized).not.toContain("accounts");
      expect(serialized).not.toContain("victim@example.com");
      expect(serialized).not.toContain("INSERT");
      expect(serialized).not.toContain("23505");
    });

    it("maps a foreign key violation (23503) to 400 without leaking the table or constraint name", () => {
      const exception = queryFailed(
        "23503",
        'insert or update on table "invoices" violates foreign key constraint "FK_invoices_account"',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.VALIDATION_ERROR,
          domain: ErrorDomain.VALIDATION,
          message: "A referenced record does not exist",
          retryable: false,
        }),
      );

      const serialized = JSON.stringify(payload());
      expect(serialized).not.toContain("invoices");
      expect(serialized).not.toContain("FK_invoices_account");
    });

    it("maps invalid text representation (22P02) to 400 and never echoes the rejected value", () => {
      const exception = queryFailed(
        "22P02",
        'invalid input syntax for type uuid: "not-a-uuid-42"',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          errorCode: ErrorCode.INVALID_PARAMETER,
          message: "A supplied value has an invalid format",
          retryable: false,
        }),
      );
      expect(JSON.stringify(payload())).not.toContain("not-a-uuid-42");
    });

    it.each([
      ["40001", HttpStatus.CONFLICT, ErrorCode.CONFLICT],
      ["55P03", HttpStatus.CONFLICT, ErrorCode.CONFLICT],
      ["53300", HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE],
    ])(
      "marks a retryable database failure (%s) as retryable with a retry hint",
      (code, status, errorCode) => {
        filter.catch(queryFailed(code, `nope: ${code}`), mockHost);

        expect(mockResponse.status).toHaveBeenCalledWith(status);
        expect(payload()).toEqual(
          expect.objectContaining({ errorCode, retryable: true }),
        );
        expect(payload().retryAfterSeconds).toBeGreaterThan(0);
      },
    );

    it("sanitizes an unmapped database code into an opaque 500", () => {
      const exception = queryFailed(
        "XX001",
        'failing to encode "plans_cache_entry" output for internal use',
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(payload().errorCode).toBe(ErrorCode.DATABASE_ERROR);
      expect(JSON.stringify(payload())).not.toContain("plans_cache_entry");
    });

    it("maps a lost connection to a retryable 503 even without a QueryFailedError wrapper", () => {
      const exception = Object.assign(
        new Error("Connection terminated unexpectedly"),
        { name: "Error", code: "ECONNREFUSED" },
      );

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect(payload()).toEqual(
        expect.objectContaining({
          errorCode: ErrorCode.SERVICE_UNAVAILABLE,
          domain: ErrorDomain.SYSTEM,
          retryable: true,
        }),
      );
      expect(JSON.stringify(payload())).not.toContain("ECONNREFUSED");
    });

    it("reads the code through a `cause` chain", () => {
      const exception = Object.assign(new Error("save failed"), {
        cause: { name: "Error", code: "23505" },
      });

      filter.catch(exception, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(payload().errorCode).toBe(ErrorCode.DUPLICATE_ENTRY);
    });

    it("returns a 404 for EntityNotFoundError without naming the entity", () => {
      filter.catch(
        new EntityNotFoundError("AccountEntity", { accountId: "acc_1" }),
        mockHost,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(payload().errorCode).toBe(ErrorCode.NOT_FOUND);
      expect(JSON.stringify(payload())).not.toContain("AccountEntity");
      expect(JSON.stringify(payload())).not.toContain("acc_1");
    });

    it("keeps the raw driver failure in the server log for diagnosis", () => {
      filter.catch(
        queryFailed(
          "23505",
          'duplicate key value violates unique constraint "accounts_email_key"',
        ),
        mockHost,
      );

      const logged = JSON.stringify(logSpy.mock.calls);
      expect(logged).toContain("accounts_email_key");
    });
  });

  describe("Unexpected & Internal Errors", () => {
    it("sanitizes database errors in production to avoid leaking SQL or connection details", () => {
      const rawDbError = new Error(
        "Connection refused at postgresql://postgres:password123@localhost:5432/swaptrade - SELECT * FROM users WHERE secret_key = 'abc'",
      );

      filter.catch(rawDbError, mockHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          errorCode: ErrorCode.INTERNAL_ERROR,
          domain: ErrorDomain.SYSTEM,
          message: "An internal server error occurred",
          retryable: false,
          recoveryGuidance: expect.stringContaining("quote the correlationId"),
        }),
      );
      // Ensure leaked password or SQL is NOT present in response
      const payload = mockResponse.json.mock.calls[0][0];
      expect(JSON.stringify(payload)).not.toContain("password123");
      expect(JSON.stringify(payload)).not.toContain("SELECT *");
    });

    it("preserves incoming correlationId from header", () => {
      mockRequest.headers["x-correlation-id"] = "custom-trace-uuid-1234";

      filter.catch(new Error("Crash"), mockHost);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        "x-correlation-id",
        "custom-trace-uuid-1234",
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: "custom-trace-uuid-1234",
        }),
      );
    });
  });
});
