import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { In, LessThan, Repository } from "typeorm";
import { PaymentProcessorFactory } from "./payment-processor.factory";
import { PaymentProcessorRegistry } from "./registry/payment-processor.registry";
import {
  CreatedPayment,
  PaymentProcessorInfo,
  PaymentRequest,
  PaymentStatusResult,
  RefundRequest,
  SignedTransaction,
  SubmittedTransaction,
} from "./interfaces/payment-processor.interface";
import {
  PaymentOperation,
  PaymentOperationState,
} from "./entities/payment-operation.entity";

/**
 * Thin orchestrator the controller delegates to. Every operation resolves the
 * target processor through the {@link PaymentProcessorFactory} (header/env/sole
 * -enabled precedence) and forwards to it, so the controller stays free of any
 * processor-selection logic.
 *
 * The operation repository checkpoints each lifecycle boundary so retries can
 * replay completed steps and reconcile interrupted external submissions.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly factory: PaymentProcessorFactory,
    private readonly registry: PaymentProcessorRegistry,
    @InjectRepository(PaymentOperation)
    private readonly operationRepository: Repository<PaymentOperation>,
  ) {}

  async createPayment(
    request: PaymentRequest,
    selector: string | undefined,
    ownerId: string,
  ): Promise<CreatedPayment> {
    const processor = this.factory.resolve(selector);
    const requestFingerprint = this.fingerprint(request);
    let operation = await this.operationRepository.findOne({
      where: {
        ownerId,
        processorName: processor.name,
        idempotencyKey: request.idempotencyKey,
      },
    });

    if (operation && operation.requestFingerprint !== requestFingerprint) {
      throw new ConflictException(
        "This idempotency key is already associated with a different payment request.",
      );
    }
    if (operation?.createdPayment) {
      return operation.createdPayment as unknown as CreatedPayment;
    }
    if (
      operation?.state === PaymentOperationState.CREATING &&
      Date.now() - operation.updatedAt.getTime() < 60_000
    ) {
      throw this.recoveryConflict(operation);
    }

    if (!operation) {
      operation = this.operationRepository.create({
        ownerId,
        processorName: processor.name,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        state: PaymentOperationState.CREATING,
      });
      try {
        operation = await this.operationRepository.save(operation);
      } catch (error) {
        operation = await this.operationRepository.findOne({
          where: {
            ownerId,
            processorName: processor.name,
            idempotencyKey: request.idempotencyKey,
          },
        });
        if (!operation) {
          throw error;
        }
        if (operation.requestFingerprint !== requestFingerprint) {
          throw new ConflictException(
            "This idempotency key is already associated with a different payment request.",
          );
        }
        if (operation.createdPayment) {
          return operation.createdPayment as unknown as CreatedPayment;
        }
        throw this.recoveryConflict(operation);
      }
    } else {
      operation.state = PaymentOperationState.CREATING;
      operation.lastError = null;
      operation = await this.operationRepository.save(operation);
    }

    try {
      const created = await processor.createPayment(request);
      const checkpointed = { ...created, recoveryId: operation.operationId };
      operation.paymentId = created.paymentId;
      operation.createdPayment = checkpointed as unknown as Record<
        string,
        unknown
      >;
      operation.state = PaymentOperationState.CREATED;
      operation.lastError = null;
      await this.operationRepository.save(operation);
      return checkpointed;
    } catch (error) {
      operation.state = PaymentOperationState.RECOVERY_REQUIRED;
      operation.lastError = this.errorMessage(error);
      await this.operationRepository.save(operation);
      throw this.recoveryRequired(operation);
    }
  }

  async signTransaction(
    created: CreatedPayment,
    selector: string | undefined,
    ownerId: string,
  ): Promise<SignedTransaction> {
    const operation = await this.findOperation(created.paymentId, ownerId);
    const processor = this.resolveOperationProcessor(operation, selector);

    if (
      operation.signedPayload &&
      [
        PaymentOperationState.SIGNED,
        PaymentOperationState.SUBMITTING,
        PaymentOperationState.RECOVERY_REQUIRED,
        PaymentOperationState.SUBMITTED,
      ].includes(operation.state)
    ) {
      return {
        paymentId: operation.paymentId,
        signedPayload: operation.signedPayload,
        signerAddress: operation.signerAddress ?? undefined,
      };
    }
    if (!operation.createdPayment) {
      throw this.recoveryConflict(operation);
    }

    const signed = await processor.signTransaction(
      operation.createdPayment as unknown as CreatedPayment,
    );
    operation.signedPayload = signed.signedPayload;
    operation.signerAddress = signed.signerAddress ?? null;
    operation.state = PaymentOperationState.SIGNED;
    operation.lastError = null;
    await this.operationRepository.save(operation);
    return signed;
  }

  async submitTransaction(
    signed: SignedTransaction,
    selector: string | undefined,
    ownerId: string,
  ): Promise<SubmittedTransaction> {
    const operation = await this.findOperation(signed.paymentId, ownerId);
    const processor = this.resolveOperationProcessor(operation, selector);

    if (operation.state === PaymentOperationState.SUBMITTED) {
      return operation.submittedTransaction as unknown as SubmittedTransaction;
    }
    if (
      !operation.signedPayload &&
      operation.state === PaymentOperationState.CREATED &&
      operation.createdPayment &&
      processor.matchesCreatedPayment?.(
        operation.createdPayment as unknown as CreatedPayment,
        signed,
      )
    ) {
      operation.signedPayload = signed.signedPayload;
      operation.state = PaymentOperationState.SIGNED;
      await this.operationRepository.save(operation);
    }
    if (
      !operation.signedPayload ||
      operation.signedPayload !== signed.signedPayload
    ) {
      throw new ConflictException(
        "The signed transaction does not match the saved recovery checkpoint.",
      );
    }

    const interrupted = [
      PaymentOperationState.SUBMITTING,
      PaymentOperationState.RECOVERY_REQUIRED,
    ].includes(operation.state);
    if (interrupted) {
      try {
        const status = await processor.getStatus(
          operation.transactionHash ?? operation.paymentId,
        );
        if (status.status !== "PENDING") {
          const submitted: SubmittedTransaction = {
            paymentId: operation.paymentId,
            transactionHash:
              status.transactionHash ??
              operation.transactionHash ??
              operation.paymentId,
            status: status.status,
            raw: status.raw,
          };
          operation.transactionHash = submitted.transactionHash;
          operation.submittedTransaction = submitted as unknown as Record<
            string,
            unknown
          >;
          operation.state = PaymentOperationState.SUBMITTED;
          operation.lastError = null;
          await this.operationRepository.save(operation);
          return submitted;
        }
      } catch (error) {
        if (!processor.supportsSafeSubmissionRetry) {
          operation.state = PaymentOperationState.RECOVERY_REQUIRED;
          operation.lastError = this.errorMessage(error);
          await this.operationRepository.save(operation);
          throw this.recoveryRequired(operation);
        }
      }
      if (!processor.supportsSafeSubmissionRetry) {
        throw this.recoveryRequired(operation);
      }
    }

    const submissionHash =
      operation.transactionHash ??
      processor.getSubmissionHash?.(signed) ??
      null;
    if (!interrupted) {
      const claim = await this.operationRepository.update(
        {
          operationId: operation.operationId,
          state: PaymentOperationState.SIGNED,
        },
        {
          state: PaymentOperationState.SUBMITTING,
          transactionHash: submissionHash,
          lastError: null,
        },
      );
      if (claim.affected === 0) {
        const latest = await this.operationRepository.findOne({
          where: { operationId: operation.operationId },
        });
        if (latest?.state === PaymentOperationState.SUBMITTED) {
          return latest.submittedTransaction as unknown as SubmittedTransaction;
        }
        throw this.recoveryRequired(latest ?? operation);
      }
      operation.state = PaymentOperationState.SUBMITTING;
      operation.transactionHash = submissionHash;
    } else {
      operation.transactionHash = submissionHash;
      operation.state = PaymentOperationState.SUBMITTING;
      await this.operationRepository.save(operation);
    }
    try {
      const submitted = await processor.submitTransaction(signed);
      operation.transactionHash = submitted.transactionHash;
      operation.submittedTransaction = submitted as unknown as Record<
        string,
        unknown
      >;
      operation.state = PaymentOperationState.SUBMITTED;
      operation.lastError = null;
      await this.operationRepository.save(operation);
      return submitted;
    } catch (error) {
      operation.state = PaymentOperationState.RECOVERY_REQUIRED;
      operation.lastError = this.errorMessage(error);
      await this.operationRepository.save(operation);
      throw this.recoveryRequired(operation);
    }
  }

  /**
   * Convenience composition of sign + submit for server-side-signing processors
   * (e.g. Stellar): resolve the processor once, sign the created payment, then
   * submit the signed result. Backs the `/payments/stellar/submit` alias so a
   * create → submit flow needs no separate client sign step.
   */
  async signAndSubmit(
    created: CreatedPayment,
    selector: string | undefined,
    ownerId: string,
  ): Promise<SubmittedTransaction> {
    const signed = await this.signTransaction(created, selector, ownerId);
    return this.submitTransaction(signed, selector, ownerId);
  }

  getStatus(
    paymentId: string,
    selector?: string,
  ): Promise<PaymentStatusResult> {
    return this.factory.resolve(selector).getStatus(paymentId);
  }

  async getRecovery(paymentId: string, ownerId: string) {
    const operation = await this.findOperation(paymentId, ownerId);
    return {
      operationId: operation.operationId,
      paymentId: operation.paymentId,
      processor: operation.processorName,
      state: operation.state,
      updatedAt: operation.updatedAt,
      nextStep: this.nextStep(operation),
    };
  }

  async resumePayment(
    paymentId: string,
    ownerId: string,
  ): Promise<SubmittedTransaction> {
    const operation = await this.findOperation(paymentId, ownerId);
    if (operation.state === PaymentOperationState.SUBMITTED) {
      return operation.submittedTransaction as unknown as SubmittedTransaction;
    }

    const processor = this.resolveOperationProcessor(operation);
    if (operation.signedPayload) {
      return this.submitTransaction(
        { paymentId, signedPayload: operation.signedPayload },
        operation.processorName,
        ownerId,
      );
    }

    if (
      operation.createdPayment &&
      !processor.capabilities.requiresClientSideSigning
    ) {
      const signed = await this.signTransaction(
        operation.createdPayment as unknown as CreatedPayment,
        operation.processorName,
        ownerId,
      );
      return this.submitTransaction(signed, operation.processorName, ownerId);
    }

    throw new ConflictException(
      `A client signature is required. Sign the saved transaction, then POST /payments/${paymentId}/submit.`,
    );
  }

  async getStuckOperations(olderThanMinutes = 15) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const operations = await this.operationRepository.find({
      where: {
        state: In([
          PaymentOperationState.CREATING,
          PaymentOperationState.SUBMITTING,
          PaymentOperationState.RECOVERY_REQUIRED,
        ]),
        updatedAt: LessThan(cutoff),
      },
      order: { updatedAt: "ASC" },
      take: 100,
    });
    return operations.map((operation) => ({
      operationId: operation.operationId,
      paymentId: operation.paymentId,
      processor: operation.processorName,
      state: operation.state,
      updatedAt: operation.updatedAt,
    }));
  }

  refund(request: RefundRequest, selector?: string) {
    return this.factory.resolve(selector).refund(request);
  }

  /** All registered processors and their enabled state, for the list endpoint. */
  listProcessors(): PaymentProcessorInfo[] {
    return this.registry.info();
  }

  enableProcessor(name: string): PaymentProcessorInfo[] {
    this.registry.enable(name);
    return this.registry.info();
  }

  disableProcessor(name: string): PaymentProcessorInfo[] {
    this.registry.disable(name);
    return this.registry.info();
  }

  private async findOperation(
    paymentId: string,
    ownerId: string,
  ): Promise<PaymentOperation> {
    const operation = await this.operationRepository.findOne({
      where: { paymentId, ownerId },
    });
    if (!operation) {
      throw new NotFoundException(
        "No saved payment recovery checkpoint exists for this payment.",
      );
    }
    return operation;
  }

  private resolveOperationProcessor(
    operation: PaymentOperation,
    selector?: string,
  ) {
    const processor = this.factory.resolve(selector ?? operation.processorName);
    if (processor.name !== operation.processorName) {
      throw new ConflictException(
        `This payment belongs to the '${operation.processorName}' processor.`,
      );
    }
    return processor;
  }

  private fingerprint(request: PaymentRequest): string {
    const canonicalize = (value: any): any => {
      if (Array.isArray(value)) {
        return value.map(canonicalize);
      }
      if (value && typeof value === "object") {
        return Object.keys(value)
          .sort()
          .reduce(
            (result, key) => {
              result[key] = canonicalize(value[key]);
              return result;
            },
            {} as Record<string, unknown>,
          );
      }
      return value;
    };
    return createHash("sha256")
      .update(JSON.stringify(canonicalize(request)))
      .digest("hex");
  }

  private recoveryConflict(operation: PaymentOperation): ConflictException {
    return new ConflictException(
      operation.paymentId
        ? `This payment operation is already in progress. Check GET /payments/${operation.paymentId}/recovery before retrying.`
        : "This payment operation is already in progress. Retry POST /payments with the same request and idempotencyKey after it completes.",
    );
  }

  private recoveryRequired(
    operation: PaymentOperation,
  ): ServiceUnavailableException {
    return new ServiceUnavailableException(
      operation.paymentId
        ? `The payment outcome could not be confirmed. Do not create a new payment. Check GET /payments/${operation.paymentId}/recovery, then retry submit with the same signedPayload.`
        : "The payment outcome could not be confirmed. Do not create a new payment. Retry POST /payments with the same request and idempotencyKey.",
    );
  }

  private nextStep(operation: PaymentOperation): string {
    switch (operation.state) {
      case PaymentOperationState.CREATED:
        return `POST /payments/${operation.paymentId}/recovery/resume`;
      case PaymentOperationState.SIGNED:
        return `POST /payments/${operation.paymentId}/recovery/resume`;
      case PaymentOperationState.SUBMITTING:
      case PaymentOperationState.RECOVERY_REQUIRED:
        return `POST /payments/${operation.paymentId}/recovery/resume; status is checked before any safe retry`;
      case PaymentOperationState.SUBMITTED:
        return `GET /payments/${operation.paymentId}/status`;
      case PaymentOperationState.CREATING:
        return "Retry the original POST /payments with the same idempotencyKey after the in-flight attempt completes.";
      default:
        return "Contact support with the recovery operationId.";
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.slice(0, 1000)
      : "Unknown error";
  }
}
