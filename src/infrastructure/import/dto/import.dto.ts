import {
  IsBoolean,
  IsEnum,
  IsArray,
  IsOptional,
  IsString,
  IsNumber,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ImportEntityType {
  PORTFOLIO_ASSETS = 'PORTFOLIO_ASSETS',
  TRANSACTIONS = 'TRANSACTIONS',
  RECONCILIATION_INVOICES = 'RECONCILIATION_INVOICES',
  ALERT_CONFIGS = 'ALERT_CONFIGS',
}

export enum ImportAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  SKIP = 'SKIP',
  ERROR = 'ERROR',
}

export class ImportOptionsDto {
  @ApiPropertyOptional({
    description: 'Allow valid rows to commit even if some rows fail validation',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowPartial?: boolean = false;

  @ApiPropertyOptional({
    description: 'Update existing records if matching externalId is found (idempotent upsert)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  updateExisting?: boolean = true;

  @ApiPropertyOptional({
    description: 'Stop processing upon encountering the first validation error',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stopOnError?: boolean = false;
}

export class PortfolioAssetImportRowDto {
  @ApiProperty({ description: 'Portfolio ID to attach the asset to' })
  @IsString()
  portfolioId: string;

  @ApiProperty({ example: 'XLM' })
  @IsString()
  symbol: string;

  @ApiProperty({ example: 1000.5 })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: 0.145 })
  @IsNumber()
  @Min(0)
  currentPrice: number;

  @ApiPropertyOptional({ example: 25.0, description: 'Target allocation percentage (0 - 100)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  targetAllocation?: number;

  @ApiPropertyOptional({ description: 'External unique identifier for idempotent re-imports' })
  @IsOptional()
  @IsString()
  externalId?: string;
}

export class TransactionImportRowDto {
  @ApiProperty({ description: 'Portfolio ID to attach transaction to' })
  @IsString()
  portfolioId: string;

  @ApiProperty({ example: 'buy', description: 'Transaction type (buy, sell, deposit, withdrawal, etc.)' })
  @IsString()
  type: string;

  @ApiProperty({ example: 500.0 })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiPropertyOptional({ example: 0.15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ example: 0.01 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fees?: number;

  @ApiPropertyOptional({ example: 'stellar' })
  @IsOptional()
  @IsString()
  chain?: string;

  @ApiPropertyOptional({ description: 'External unique identifier for idempotent re-imports' })
  @IsOptional()
  @IsString()
  externalId?: string;

  @ApiPropertyOptional({ description: 'Optional linked Portfolio Asset ID' })
  @IsOptional()
  @IsString()
  portfolioAssetId?: string;
}

export class ReconciliationInvoiceImportRowDto {
  @ApiProperty({ example: 'INV-2026-001', description: 'Unique Invoice Identifier' })
  @IsString()
  invoiceId: string;

  @ApiProperty({ example: '100.0000000', description: 'Expected payment amount (Stellar 7 decimal precision)' })
  @IsString()
  expectedAmount: string;

  @ApiPropertyOptional({ example: 'XLM', default: 'XLM', description: 'Asset Code (1-12 chars)' })
  @IsOptional()
  @IsString()
  assetCode?: string;

  @ApiProperty({ example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', description: 'Destination Stellar Account' })
  @IsString()
  destinationAccount: string;

  @ApiPropertyOptional({ example: 'ORDER-9988', description: 'Payment reference / memo' })
  @IsOptional()
  @IsString()
  paymentReference?: string;

  @ApiPropertyOptional({ description: 'External unique identifier for idempotent re-imports' })
  @IsOptional()
  @IsString()
  externalId?: string;
}

export class ImportRequestDto {
  @ApiProperty({ enum: ImportEntityType, description: 'Target entity domain for the import batch' })
  @IsEnum(ImportEntityType)
  entityType: ImportEntityType;

  @ApiPropertyOptional({
    description: 'When true, validates and previews changes with ZERO persistent database writes',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean = true;

  @ApiProperty({ description: 'Array of entity rows to import', type: [Object] })
  @IsArray()
  rows: any[];

  @ApiPropertyOptional({ type: ImportOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportOptionsDto)
  options?: ImportOptionsDto;
}

export interface ImportDiffPreview {
  rowIndex: number;
  externalId?: string;
  action: ImportAction;
  summary: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
}

export interface ImportErrorDetail {
  rowIndex: number;
  externalId?: string;
  field?: string;
  rejectedValue?: any;
  errorMessage: string;
  remediation: string;
}

export interface ImportRollbackGuidance {
  transactionId: string;
  snapshotTimestamp: Date;
  affectedRecordIds: string[];
  remediationSteps: string[];
  rollbackInstructions: string;
}

export class ImportResultDto {
  @ApiProperty({ description: 'Whether this execution was a dry-run (read-only)' })
  dryRun: boolean;

  @ApiProperty({ enum: ImportEntityType })
  entityType: ImportEntityType;

  @ApiProperty({ description: 'Total number of rows submitted in this batch' })
  totalRows: number;

  @ApiProperty({ description: 'Number of new records created or planned for creation' })
  createCount: number;

  @ApiProperty({ description: 'Number of existing records updated or planned for update' })
  updateCount: number;

  @ApiProperty({ description: 'Number of rows skipped without changes' })
  skipCount: number;

  @ApiProperty({ description: 'Number of invalid rows that failed validation' })
  errorCount: number;

  @ApiProperty({ description: 'Overall batch success status' })
  isSuccess: boolean;

  @ApiProperty({ description: 'Detailed diff preview of proposed or applied changes' })
  preview: ImportDiffPreview[];

  @ApiProperty({ description: 'Validation errors with exact row locations and remediation guidance' })
  errors: ImportErrorDetail[];

  @ApiPropertyOptional({ description: 'Rollback instructions and compensation metadata' })
  rollbackGuidance?: ImportRollbackGuidance;

  @ApiProperty({ description: 'Execution time in milliseconds' })
  executionTimeMs: number;
}
