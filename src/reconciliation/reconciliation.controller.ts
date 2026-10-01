import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { AdminTwoFactorGuard } from "../core/auth/guards/admin-two-factor.guard";
import { RolesGuard } from "../common/guard/roles.guard";
import { Roles } from "../common/guard/roles.decorator";
import { Role } from "../common/guard/roles.enum";
import {
  CreateReconciliationInvoiceDto,
  IngestStellarTransactionDto,
  ManualReconciliationDto,
} from "./dto/reconciliation.dto";
import {
  TransactionDetailsQueryDto,
  TransactionDetailsResponseDto,
  TransactionDisclosureDto,
  TransactionSectionStateDto,
  TransactionWarningDto,
} from "../common/transaction-details/dto/transaction-details.dto";
import { ReconciliationService } from "./reconciliation.service";
import { TransactionDetailsService } from "./transaction-details.service";

@ApiTags("Stellar Reconciliation")
@Controller("reconcile/stellar")
@ApiExtraModels(
  TransactionDetailsResponseDto,
  TransactionDisclosureDto,
  TransactionSectionStateDto,
  TransactionWarningDto,
)
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly transactionDetailsService: TransactionDetailsService,
  ) {}

  @Post("invoice")
  @ApiOperation({ summary: "Register an invoice for Stellar reconciliation" })
  createInvoice(@Body() dto: CreateReconciliationInvoiceDto) {
    return this.reconciliationService.createInvoice(dto);
  }

  @Post("transactions")
  @ApiQuery({
    name: "details",
    required: false,
    enum: ["summary", "standard", "advanced"],
    description:
      "Opt in to the tiered transaction view. Omit for the legacy response shape.",
  })
  @ApiQuery({
    name: "dryRun",
    required: false,
    type: Boolean,
    description:
      "Validate and project the payment without persisting it. Use with " +
      "'details=advanced' to inspect the full advanced view before submission.",
  })
  @ApiResponse({
    status: 201,
    description: "Payment recorded and reconciled",
  })
  @ApiResponse({
    status: 200,
    description: "Dry run: the payment was validated but nothing was written",
    type: TransactionDetailsResponseDto,
  })
  @ApiOperation({
    summary: "Ingest a confirmed Stellar payment",
    description:
      "Idempotently records a payment and reconciles it against an invoice by destination, asset, and memo/reference. " +
      "With `dryRun=true` nothing is written and the response carries the tiered projection " +
      "(including `advanced`) plus every warning, so the advanced view is available before submission.",
  })
  async ingestTransaction(
    @Body() dto: IngestStellarTransactionDto,
    @Query() query: TransactionDetailsQueryDto,
  ) {
    if (query.dryRun) {
      return this.transactionDetailsService.preview(dto, query.details);
    }
    if (query.details) {
      const projected = await this.transactionDetailsService.describe(
        dto.transactionId,
        query.details,
      );
      if (projected) {
        return projected;
      }
    }
    return this.reconciliationService.ingestTransaction(dto);
  }

  @Get("tx/:txid")
  @ApiParam({ name: "txid", description: "Stellar transaction hash" })
  @ApiQuery({
    name: "details",
    required: false,
    enum: ["summary", "standard", "advanced"],
    description:
      "Opt in to the tiered transaction view. Omit for the legacy response shape " +
      "(`{ transaction, audits }`), which is unchanged for backwards compatibility.",
  })
  @ApiOperation({
    summary: "Look up a Stellar transaction and its decisions",
    description:
      "Without `details` the legacy `{ transaction, audits }` payload is returned. " +
      "With `details` the response is a disclosure envelope: identity, settlement and risk " +
      "at `summary`; timeline and audit trail at `standard`; amount precision, reference " +
      "analysis and the raw protocol payload at `advanced`. Warnings and critical-risk " +
      "sections are returned at every tier.",
  })
  @ApiResponse({
    status: 200,
    description: "Transaction with the requested level of detail",
    type: TransactionDetailsResponseDto,
  })
  async getTransaction(
    @Param("txid") transactionId: string,
    @Query() query: TransactionDetailsQueryDto,
  ) {
    if (!query.details) {
      return this.reconciliationService.getTransaction(transactionId);
    }
    const projected = await this.transactionDetailsService.describe(
      transactionId,
      query.details,
    );
    if (!projected) {
      return this.reconciliationService.getTransaction(transactionId);
    }
    return projected;
  }

  @Get("invoice/:invoiceId")
  @ApiParam({ name: "invoiceId", description: "Internal invoice identifier" })
  @ApiOperation({
    summary: "Look up an invoice and its reconciliation audit trail",
  })
  getInvoice(@Param("invoiceId") invoiceId: string) {
    return this.reconciliationService.getInvoice(invoiceId);
  }

  @Post("invoice/:invoiceId/reconcile")
  @ApiParam({ name: "invoiceId", description: "Internal invoice identifier" })
  @ApiOperation({ summary: "Retry reconciliation for an invoice" })
  manualReconcile(
    @Param("invoiceId") invoiceId: string,
    @Body() dto: ManualReconciliationDto
  ) {
    return this.reconciliationService.manualReconcile(invoiceId, dto);
  }

  @Get("admin/unmatched")
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List unmatched Stellar transactions" })
  @ApiQuery({ name: "limit", required: false, type: Number, example: 50 })
  listUnmatched(
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.reconciliationService.listUnmatched(limit);
  }

  @Get("admin/audit")
  @UseGuards(JwtAuthGuard, RolesGuard, AdminTwoFactorGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List reconciliation decisions" })
  @ApiQuery({ name: "invoiceId", required: false })
  @ApiQuery({ name: "transactionId", required: false })
  listAudits(
    @Query("invoiceId") invoiceId?: string,
    @Query("transactionId") transactionId?: string
  ) {
    return this.reconciliationService.listAudits(invoiceId, transactionId);
  }
}
