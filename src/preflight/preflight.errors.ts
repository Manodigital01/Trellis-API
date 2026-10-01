import { HttpStatus } from "@nestjs/common";
import { AppException } from "src/common/errors/app.exception";
import { ErrorCode } from "src/common/errors/error-codes";
import { PreflightFinding, PreflightResult } from "./preflight.types";

/**
 * Thrown when a caller asks the preflight to *assert* that an operation may
 * proceed and the evaluation returned `blocking`.
 *
 * It extends the repo's {@link AppException} so the global exception filter
 * renders it with the standard error envelope (`errorCode`, `domain`,
 * `retryable`, `recoveryGuidance`). The full finding list is attached so
 * clients can render remediation for every blocker, not just the first.
 */
export class PreflightBlockedException extends AppException {
  /** Id of the blocked preflight result, for support correlation. */
  public readonly preflightId: string;

  /** Every finding from the blocked evaluation, in canonical order. */
  public readonly findings: PreflightFinding[];

  constructor(result: PreflightResult) {
    const blockers = result.findings.filter((f) => f.severity === "blocking");
    const message =
      blockers.map((f) => f.message).join(" ") ||
      "Preflight blocked this operation.";
    const guidance =
      blockers.find((f) => f.remediation)?.remediation ??
      "Resolve the blocking findings, rebuild the operation and preflight it again.";

    super(message, HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.PRECONDITION_FAILED, {
      domain: undefined,
      retryable: false,
      recoveryGuidance: guidance,
    });

    this.preflightId = result.preflightId;
    this.findings = result.findings;
  }
}
