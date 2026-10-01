/**
 * @file trellis-contract.types.ts
 *
 * Shared typed integration contract for cross-repo Trellis integrations (issue #120).
 *
 * These types are the single source of truth for shapes exchanged between
 * frontend, API, and contract-facing code.  Any breaking change here must be
 * accompanied by a contract-test update and a CHANGELOG entry.
 *
 * Consumers:
 *  - Trellis-API  (this repo — REST controllers validate against these)
 *  - Trellis-Frontend (imports from published @trellis/contract)
 *  - Smart-contract adapters (import via generated SDK)
 */

// ---------------------------------------------------------------------------
// Primitive aliases — use these instead of raw `string` where the semantic
// matters so type-checkers can catch mix-ups between ids and addresses.
// ---------------------------------------------------------------------------
export type UserId = string;
export type AgentId = string;
export type PortfolioId = string;
export type WalletAddress = string;
export type OperationId = string;
export type CorrelationId = string;
export type ISODateString = string;
export type StellarTxHash = string;

// ---------------------------------------------------------------------------
// Envelope — every API response is wrapped in this shape
// ---------------------------------------------------------------------------
export interface ApiEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface ResponseMeta {
  requestId: CorrelationId;
  timestamp: ISODateString;
  apiVersion: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total?: number;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export interface ApiErrorResponse {
  statusCode: number;
  errorCode: string;
  domain: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  recoveryGuidance?: string;
  correlationId: CorrelationId;
  timestamp: ISODateString;
  path: string;
  errors?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export interface ChallengeRequest {
  walletAddress: WalletAddress;
}

export interface ChallengeResponse {
  nonce: string;
  message: string;
  expiresAt: ISODateString;
}

export interface VerifyRequest {
  walletAddress: WalletAddress;
  signature: string;
  nonce: string;
}

export interface AuthToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  userId: UserId;
  roles: string[];
}

// ---------------------------------------------------------------------------
// Operations — core statuses shared across the platform
// ---------------------------------------------------------------------------
export enum OperationStatus {
  Pending    = 'pending',
  Processing = 'processing',
  Succeeded  = 'succeeded',
  Failed     = 'failed',
  Cancelled  = 'cancelled',
  Recoverable = 'recoverable',
  RequiresAction = 'requires_action',
}

export enum OperationType {
  Payment        = 'payment',
  Portfolio      = 'portfolio',
  AgentCompute   = 'agent_compute',
  Submission     = 'submission',
  Import         = 'import',
  Export         = 'export',
  Staking        = 'staking',
  Rebalancing    = 'rebalancing',
}

export interface OperationReceipt {
  operationId: OperationId;
  type: OperationType;
  status: OperationStatus;
  userId: UserId;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  correlationId: CorrelationId;
  metadata?: Record<string, unknown>;
  errorDetail?: OperationErrorDetail;
  recoveryAction?: RecoveryAction;
}

export interface OperationErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  occurredAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
export interface RecoveryAction {
  actionId: string;
  label: string;
  description: string;
  endpoint: string;
  method: 'POST' | 'DELETE' | 'PATCH';
  requiresConfirmation: boolean;
}

export type RecoveryState =
  | 'unresolved'   // visible in recovery center
  | 'in_progress'  // user/system actively handling it
  | 'resolved'     // no longer requires action
  | 'dismissed';   // user explicitly dismissed

export interface RecoveryEntry {
  id: string;
  operationId: OperationId;
  operationType: OperationType;
  userId: UserId;
  state: RecoveryState;
  title: string;
  description: string;
  availableActions: RecoveryAction[];
  createdAt: ISODateString;
  resolvedAt?: ISODateString;
}

// ---------------------------------------------------------------------------
// Rate-limit headers & responses
// ---------------------------------------------------------------------------
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: ISODateString;
  retryAfterMs?: number;
  scope: string;
}

export interface RateLimitExceededResponse {
  errorCode: 'RATE_LIMITED';
  message: string;
  limit: number;
  remaining: 0;
  resetAt: ISODateString;
  retryAfterMs: number;
  scope: string;
}

// ---------------------------------------------------------------------------
// Snapshot (issue #119 contract surface)
// ---------------------------------------------------------------------------
export interface SnapshotSummary {
  id: string;
  label?: string;
  scope: string;
  createdAt: ISODateString;
  integrityHash: string;
  recordCount: number;
  redactedFields: string[];
}

export interface SnapshotVerification {
  snapshotId: string;
  valid: boolean;
  hashMatch: boolean;
  signatureMatch: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Version guard
// ---------------------------------------------------------------------------
/**
 * CONTRACT_VERSION is a semver string.  Increment MAJOR on breaking changes,
 * MINOR for new optional fields, PATCH for corrections/docs only.
 *
 * Consumers should assert `CONTRACT_VERSION` matches their expected range at
 * startup to detect drift early.
 */
export const CONTRACT_VERSION = '1.0.0';
