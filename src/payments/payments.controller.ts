import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { Roles } from "src/common/guard/roles.decorator";
import { RolesGuard } from "src/common/guard/roles.guard";
import { Role } from "src/common/guard/roles.enum";
import { PaymentsService } from "./payments.service";
import { CreatePaymentDto, SignTransactionDto } from "./dto/create-payment.dto";
import { SubmitTransactionDto } from "./dto/submit-transaction.dto";
import { RefundDto } from "./dto/refund.dto";
import {
  CreatedPayment,
  PaymentProcessorInfo,
  PaymentStatusResult,
  RefundResult,
  SignedTransaction,
  SubmittedTransaction,
} from "./interfaces/payment-processor.interface";

/** Header that selects the processor for a request (overrides env default). */
const PROCESSOR_HEADER = "x-payment-processor";

/**
 * Payments API — a single set of endpoints in front of every registered
 * payment processor. Which processor handles a call is chosen per request via
 * the `X-Payment-Processor` header (or `?processor=`), falling back to the
 * `PAYMENTS_DEFAULT_PROCESSOR` env default, then to the sole enabled processor.
 *
 * Guarded by JWT (+ the global KYC guard). Enable/disable are admin-only.
 * The create → sign → submit flow is checkpointed so interrupted operations
 * can be reconciled without blindly repeating external side effects.
 */
@ApiTags("Payments")
@ApiBearerAuth()
@Controller("payments")
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create (but do not submit) a payment" })
  createPayment(
    @Body() dto: CreatePaymentDto,
    @Headers(PROCESSOR_HEADER) headerProcessor?: string,
    @Query("processor") queryProcessor?: string,
    @Req() request?: any,
  ): Promise<CreatedPayment> {
    return this.paymentsService.createPayment(
      dto,
      queryProcessor ?? headerProcessor,
      this.ownerId(request),
    );
  }

  @Post(":id/sign")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sign a created payment" })
  @ApiParam({ name: "id", description: "Payment id from createPayment" })
  signTransaction(
    @Param("id") id: string,
    @Body() dto: SignTransactionDto,
    @Headers(PROCESSOR_HEADER) headerProcessor?: string,
    @Query("processor") queryProcessor?: string,
    @Req() request?: any,
  ): Promise<SignedTransaction> {
    return this.paymentsService.signTransaction(
      { paymentId: id, ...dto },
      queryProcessor ?? headerProcessor,
      this.ownerId(request),
    );
  }

  @Post(":id/submit")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Submit a signed transaction" })
  @ApiParam({ name: "id", description: "Payment id from createPayment" })
  submitTransaction(
    @Param("id") id: string,
    @Body() dto: SubmitTransactionDto,
    @Headers(PROCESSOR_HEADER) headerProcessor?: string,
    @Query("processor") queryProcessor?: string,
    @Req() request?: any,
  ): Promise<SubmittedTransaction> {
    return this.paymentsService.submitTransaction(
      { paymentId: id, ...dto },
      queryProcessor ?? headerProcessor,
      this.ownerId(request),
    );
  }

  @Get(":id/status")
  @ApiOperation({ summary: "Get the status of a payment/transaction" })
  @ApiParam({ name: "id", description: "Payment id or transaction hash" })
  getStatus(
    @Param("id") id: string,
    @Headers(PROCESSOR_HEADER) headerProcessor?: string,
    @Query("processor") queryProcessor?: string,
  ): Promise<PaymentStatusResult> {
    return this.paymentsService.getStatus(
      id,
      queryProcessor ?? headerProcessor,
    );
  }

  @Get("recovery/stuck")
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "List stale payment operations for maintainers" })
  getStuckOperations(
    @Query("olderThanMinutes") olderThanMinutes?: string,
  ) {
    const parsed = Number(olderThanMinutes);
    return this.paymentsService.getStuckOperations(
      Number.isFinite(parsed) && parsed > 0 ? parsed : 15,
    );
  }

  @Get(":id/recovery")
  @ApiOperation({ summary: "Get recovery status and next steps for a payment" })
  @ApiParam({ name: "id", description: "Payment id from createPayment" })
  getRecovery(@Param("id") id: string, @Req() request?: any) {
    return this.paymentsService.getRecovery(id, this.ownerId(request));
  }

  @Post(":id/recovery/resume")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume or reconcile an interrupted payment" })
  @ApiParam({ name: "id", description: "Payment id from createPayment" })
  resumePayment(@Param("id") id: string, @Req() request?: any) {
    return this.paymentsService.resumePayment(id, this.ownerId(request));
  }

  @Post(":id/refund")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Refund a payment (full or partial)" })
  @ApiParam({ name: "id", description: "Payment id or transaction hash" })
  refund(
    @Param("id") id: string,
    @Body() dto: RefundDto,
    @Headers(PROCESSOR_HEADER) headerProcessor?: string,
    @Query("processor") queryProcessor?: string,
  ): Promise<RefundResult> {
    return this.paymentsService.refund(
      { paymentId: id, ...dto },
      queryProcessor ?? headerProcessor,
    );
  }

  @Get("processors")
  @ApiOperation({ summary: "List registered processors and their state" })
  listProcessors(): PaymentProcessorInfo[] {
    return this.paymentsService.listProcessors();
  }

  @Post("processors/:name/enable")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Enable a processor (admin only)" })
  @ApiParam({ name: "name", description: "Processor name, e.g. 'stellar'" })
  enableProcessor(@Param("name") name: string): PaymentProcessorInfo[] {
    return this.paymentsService.enableProcessor(name);
  }

  @Post("processors/:name/disable")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Disable a processor (admin only)" })
  @ApiParam({ name: "name", description: "Processor name, e.g. 'stellar'" })
  disableProcessor(@Param("name") name: string): PaymentProcessorInfo[] {
    return this.paymentsService.disableProcessor(name);
  }

  private ownerId(request?: any): string {
    const id = request?.user?.sub ?? request?.user?.id;
    if (!id) {
      throw new UnauthorizedException("Authenticated user identity is missing.");
    }
    return String(id);
  }
}
