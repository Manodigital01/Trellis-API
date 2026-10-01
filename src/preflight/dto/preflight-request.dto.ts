import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  PreflightIdempotencyRecord,
  PreflightOperationKind,
  PreflightOraclePrice,
} from "../preflight.types";

/** Non-negative decimal string, e.g. "10" or "10.5". No sign, no exponent. */
const DECIMAL_STRING = /^\d+(\.\d+)?$/;

const OPERATION_KINDS: PreflightOperationKind[] = [
  "payment_transfer",
  "trade",
  "oracle_submission",
];

/** One oracle price observation in the state snapshot. */
export class PreflightOraclePriceDto implements PreflightOraclePrice {
  @ApiProperty({ example: "XLM" })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiProperty({ description: "Exact decimal price string", example: "0.42" })
  @IsString()
  @Matches(DECIMAL_STRING, {
    message: "price must be a non-negative decimal string, e.g. '0.42'",
  })
  price: string;

  @ApiProperty({ description: "ISO timestamp the price was observed" })
  @IsISO8601()
  updatedAt: string;
}

/** One idempotency record in the state snapshot. */
export class PreflightIdempotencyRecordDto implements PreflightIdempotencyRecord {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  key: string;

  @ApiProperty({ description: "Digest of the request stored under this key" })
  @IsString()
  @IsNotEmpty()
  requestDigest: string;

  @ApiPropertyOptional({ enum: ["in_progress", "completed", "failed"] })
  @IsOptional()
  @IsString()
  status?: string;
}

/** Point-in-time state the operation is evaluated against. */
export class PreflightStateDto {
  @ApiPropertyOptional({
    description:
      "ISO timestamp the state was observed. Defaults to the evaluation instant.",
  })
  @IsOptional()
  @IsISO8601()
  observedAt?: string;

  @ApiPropertyOptional({
    description: "Asset (upper-case) -> exact decimal balance",
    example: { XLM: "100.5" },
  })
  @IsOptional()
  @IsObject()
  balances?: Record<string, string>;

  @ApiPropertyOptional({
    description: "Asset (upper-case) -> exact decimal allowance",
    example: { USDC: "25" },
  })
  @IsOptional()
  @IsObject()
  allowances?: Record<string, string>;

  @ApiPropertyOptional({
    description: "Digests of operations already executed for this account",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  consumedDigests?: string[];

  @ApiPropertyOptional({ type: [PreflightIdempotencyRecordDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreflightIdempotencyRecordDto)
  idempotencyRecords?: PreflightIdempotencyRecordDto[];

  @ApiPropertyOptional({
    description:
      "Destinations already verified for this account. An empty list means 'unknown' and disables the check.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  verifiedDestinations?: string[];

  @ApiPropertyOptional({ type: [PreflightOraclePriceDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreflightOraclePriceDto)
  oracle?: PreflightOraclePriceDto[];
}

/** Body for `POST /preflight` — evaluate one high-risk operation. */
export class PreflightRequestDto {
  @ApiProperty({ enum: OPERATION_KINDS, example: "payment_transfer" })
  @IsIn(OPERATION_KINDS)
  kind: PreflightOperationKind;

  @ApiProperty({ example: "XLM" })
  @IsString()
  @IsNotEmpty()
  asset: string;

  @ApiProperty({ description: "Exact decimal amount string", example: "10.5" })
  @IsString()
  @Matches(DECIMAL_STRING, {
    message: "amount must be a non-negative decimal string, e.g. '10.5'",
  })
  amount: string;

  @ApiPropertyOptional({ enum: ["buy", "sell"], description: "Required for trades" })
  @ValidateIf((dto: PreflightRequestDto) => dto.kind === "trade")
  @IsIn(["buy", "sell"])
  side?: string;

  @ApiPropertyOptional({ description: "Destination address for transfers" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  destination?: string;

  @ApiPropertyOptional({ description: "Idempotency key for the operation" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;

  @ApiPropertyOptional({
    description: "Whether the operation depends on a fresh oracle price",
  })
  @IsOptional()
  @IsBoolean()
  requiresOraclePrice?: boolean;

  @ApiPropertyOptional({
    description: "State version the operation was prepared against",
  })
  @IsOptional()
  @IsString()
  expectedStateVersion?: string;

  @ApiPropertyOptional({ description: "ISO timestamp after which it is invalid" })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    description: "Exact decimal estimate of the network fee",
    example: "0.00001",
  })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_STRING, {
    message: "estimatedFee must be a non-negative decimal string",
  })
  estimatedFee?: string;

  @ApiProperty({ description: "Opaque version of the state snapshot" })
  @IsString()
  @IsNotEmpty()
  stateVersion: string;

  @ApiPropertyOptional({
    description:
      "Evaluation instant (ISO). Supplied by the caller; omit to use the server clock.",
  })
  @IsOptional()
  @IsISO8601()
  asOf?: string;

  @ApiPropertyOptional({ type: PreflightStateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PreflightStateDto)
  state?: PreflightStateDto;
}
