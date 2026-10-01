import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { SemanticValidatorService, SemanticValidationErrorCode } from "./semantic-validator.service";

describe("SemanticValidatorService", () => {
  let service: SemanticValidatorService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [SemanticValidatorService],
    }).compile();

    service = module.get<SemanticValidatorService>(SemanticValidatorService);
  });

  describe("validateDateRange", () => {
    it("should pass when startDate equals endDate", () => {
      const date = "2025-01-15T00:00:00Z";
      expect(() => service.validateDateRange(date, date)).not.toThrow();
    });

    it("should pass when startDate is before endDate", () => {
      expect(() =>
        service.validateDateRange("2025-01-01T00:00:00Z", "2025-01-31T00:00:00Z"),
      ).not.toThrow();
    });

    it("should throw when startDate is after endDate", () => {
      expect(() =>
        service.validateDateRange("2025-01-31T00:00:00Z", "2025-01-01T00:00:00Z"),
      ).toThrow(BadRequestException);
    });

    it("should throw on invalid date format", () => {
      expect(() => service.validateDateRange("invalid", "2025-01-01")).toThrow(
        BadRequestException,
      );
    });

    it("should include error code in response", () => {
      try {
        service.validateDateRange("2025-12-31", "2025-01-01");
        fail("Should have thrown");
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as any;
          expect(response.message).toBe(SemanticValidationErrorCode.INVALID_DATE_RANGE);
        }
      }
    });
  });

  describe("validateMaximum", () => {
    it("should pass when value equals maximum", () => {
      expect(() => service.validateMaximum(100, 100, "amount")).not.toThrow();
    });

    it("should pass when value is below maximum", () => {
      expect(() => service.validateMaximum(50, 100, "amount")).not.toThrow();
    });

    it("should throw when value exceeds maximum", () => {
      expect(() => service.validateMaximum(150, 100, "amount")).toThrow(
        BadRequestException,
      );
    });

    it("should include context in error response", () => {
      try {
        service.validateMaximum(150, 100, "amount", { account: "user123" });
        fail("Should have thrown");
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as any;
          expect(response.errors[0].context).toMatchObject({
            value: 150,
            maximum: 100,
            account: "user123",
          });
        }
      }
    });
  });

  describe("validateMinimum", () => {
    it("should pass when value equals minimum", () => {
      expect(() => service.validateMinimum(100, 100, "amount")).not.toThrow();
    });

    it("should pass when value is above minimum", () => {
      expect(() => service.validateMinimum(150, 100, "amount")).not.toThrow();
    });

    it("should throw when value is below minimum", () => {
      expect(() => service.validateMinimum(50, 100, "amount")).toThrow(
        BadRequestException,
      );
    });
  });

  describe("validateNoDuplicates", () => {
    it("should pass when array has no duplicates", () => {
      const items = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];
      expect(() => service.validateNoDuplicates(items, (i) => i.id)).not.toThrow();
    });

    it("should throw when array has duplicates", () => {
      const items = [
        { id: 1, name: "Alice" },
        { id: 1, name: "Alice2" },
      ];
      expect(() => service.validateNoDuplicates(items, (i) => i.id)).toThrow(
        BadRequestException,
      );
    });

    it("should handle string keys", () => {
      const items = [
        { email: "alice@example.com" },
        { email: "alice@example.com" },
      ];
      expect(() => service.validateNoDuplicates(items, (i) => i.email)).toThrow(
        BadRequestException,
      );
    });

    it("should identify multiple duplicates", () => {
      const items = [
        { id: 1 },
        { id: 1 },
        { id: 2 },
        { id: 2 },
      ];
      try {
        service.validateNoDuplicates(items, (i) => i.id);
        fail("Should have thrown");
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as any;
          expect(response.errors[0].context.duplicateCount).toBe(2);
        }
      }
    });
  });

  describe("validateBusinessPattern", () => {
    it("should pass when value matches pattern", () => {
      const pattern = /^[A-Z]{2}\d{4}$/;
      expect(() => service.validateBusinessPattern("AB1234", pattern, "code")).not.toThrow();
    });

    it("should throw when value does not match pattern", () => {
      const pattern = /^[A-Z]{2}\d{4}$/;
      expect(() => service.validateBusinessPattern("INVALID", pattern, "code")).toThrow(
        BadRequestException,
      );
    });

    it("should include pattern description in error", () => {
      const pattern = /^[A-Z]{2}\d{4}$/;
      try {
        service.validateBusinessPattern(
          "invalid",
          pattern,
          "code",
          "format: 2 letters + 4 digits",
        );
        fail("Should have thrown");
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as any;
          expect(response.errors[0].constraints.patternMismatch).toContain(
            "2 letters + 4 digits",
          );
        }
      }
    });
  });

  describe("validateExclusive", () => {
    it("should pass when only one field is provided", () => {
      const obj = { fieldA: "value", fieldB: undefined };
      expect(() => service.validateExclusive(obj, ["fieldA", "fieldB"])).not.toThrow();
    });

    it("should pass when no fields are provided", () => {
      const obj = { fieldA: undefined, fieldB: null };
      expect(() => service.validateExclusive(obj, ["fieldA", "fieldB"])).not.toThrow();
    });

    it("should throw when multiple fields are provided", () => {
      const obj = { fieldA: "value1", fieldB: "value2" };
      expect(() => service.validateExclusive(obj, ["fieldA", "fieldB"])).toThrow(
        BadRequestException,
      );
    });

    it("should handle three or more exclusive fields", () => {
      const obj = { fieldA: "value", fieldB: "value", fieldC: null };
      expect(() =>
        service.validateExclusive(obj, ["fieldA", "fieldB", "fieldC"]),
      ).toThrow(BadRequestException);
    });
  });

  describe("validateAtLeastOne", () => {
    it("should pass when at least one field is provided", () => {
      const obj = { fieldA: "value", fieldB: undefined };
      expect(() => service.validateAtLeastOne(obj, ["fieldA", "fieldB"])).not.toThrow();
    });

    it("should throw when no fields are provided", () => {
      const obj = { fieldA: undefined, fieldB: null };
      expect(() => service.validateAtLeastOne(obj, ["fieldA", "fieldB"])).toThrow(
        BadRequestException,
      );
    });

    it("should throw when all fields are undefined", () => {
      const obj = { fieldA: undefined, fieldB: undefined };
      expect(() => service.validateAtLeastOne(obj, ["fieldA", "fieldB"])).toThrow(
        BadRequestException,
      );
    });
  });

  describe("validateConditionalRequired", () => {
    it("should pass when condition field is absent", () => {
      const obj = { conditionField: undefined, requiredField: undefined };
      expect(() =>
        service.validateConditionalRequired(obj, "conditionField", ["requiredField"]),
      ).not.toThrow();
    });

    it("should pass when condition field is present and required field is provided", () => {
      const obj = { conditionField: "value", requiredField: "value" };
      expect(() =>
        service.validateConditionalRequired(obj, "conditionField", ["requiredField"]),
      ).not.toThrow();
    });

    it("should throw when condition field is present but required field is missing", () => {
      const obj = { conditionField: "value", requiredField: undefined };
      expect(() =>
        service.validateConditionalRequired(obj, "conditionField", ["requiredField"]),
      ).toThrow(BadRequestException);
    });

    it("should handle multiple required fields", () => {
      const obj = {
        conditionField: "value",
        required1: "value",
        required2: undefined,
      };
      expect(() =>
        service.validateConditionalRequired(obj, "conditionField", [
          "required1",
          "required2",
        ]),
      ).toThrow(BadRequestException);
    });

    it("should pass when all required fields are present", () => {
      const obj = {
        conditionField: "value",
        required1: "value",
        required2: "value",
      };
      expect(() =>
        service.validateConditionalRequired(obj, "conditionField", [
          "required1",
          "required2",
        ]),
      ).not.toThrow();
    });
  });

  describe("error codes", () => {
    it("should use stable error codes for identification", () => {
      try {
        service.validateDateRange("2025-12-31", "2025-01-01");
        fail("Should have thrown");
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as any;
          expect(Object.values(SemanticValidationErrorCode)).toContain(response.message);
        }
      }
    });

    it("should not leak internal field names in error messages", () => {
      try {
        service.validateMaximum(150, 100);
        fail("Should have thrown");
      } catch (err) {
        if (err instanceof BadRequestException) {
          const response = err.getResponse() as any;
          const errorString = JSON.stringify(response);
          expect(errorString).not.toContain("private");
          expect(errorString).not.toContain("internal");
        }
      }
    });
  });
});
