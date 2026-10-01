# Trellis Public API Contract & Integration Specification

## 1. Overview & Architecture

The **Trellis API** is a high-performance backend and integration gateway for Trellis protocol operations on the Stellar network and Soroban smart contracts. It exposes RESTful and event-driven interfaces for portfolio management, automated rebalancing, decentralized oracle data feeds, multi-channel notifications, bulk data imports, and Stellar payment reconciliation.

- **Base URL (Local/Dev):** `http://localhost:3001/api/v1`
- **Base URL (Staging):** `https://staging-api.trellis.network/api/v1`
- **Base URL (Production):** `https://api.trellis.network/api/v1`
- **Authoritative OpenAPI 3.0 Spec:** [`docs/openapi.json`](file:///Users/favoureze/Trellis-API/docs/openapi.json)
- **Interactive Swagger UI:** `/api/docs`
- **Contract Drift CI Suite:** `npm run test:contract` ([`src/common/contract/api-contract-drift.spec.ts`](file:///Users/favoureze/Trellis-API/src/common/contract/api-contract-drift.spec.ts))

---

## 2. Authentication & Authorization Contracts

Trellis API enforces strict authentication and role-based access control (RBAC) across all integration surfaces.

### 2.1 Supported Auth Schemes

| Auth Scheme | Header / Transport | Description |
| :--- | :--- | :--- |
| **Bearer JWT** | `Authorization: Bearer <token>` | User session token issued upon successful Stellar challenge verification or credential login. |
| **Machine API Key** | `X-API-Key: <key>` | Machine-to-machine service authentication for automated trading bots, indexers, and oracle submitters. |
| **Stellar Challenge Signature** | Cryptographic challenge payload | SEP-0010 compliant Ed25519 cryptographic challenge-response for non-custodial wallet authentication. |

### 2.2 Roles & Permissions Matrix

Endpoints decorated with `@Roles(...)` and `@RequireKyc(...)` enforce the following access hierarchy:

| Role | Description | Allowed Operations |
| :--- | :--- | :--- |
| `USER` | Standard authenticated user | Manage own portfolios, subscribe to notifications, view reconciliation status. |
| `AGENT` | Autonomous trading agent | Automated trade execution, dry-run validations, price queries. |
| `OPERATOR` | Platform operator | Bulk data imports (`PORTFOLIO_ASSETS`, `TRANSACTIONS`), manual reconciliation overrides. |
| `ADMIN` | System administrator | Disaster recovery validation (`/dr/validate`), user role management, system audit queries. Requires 2FA. |

---

## 3. Standard Request & Response Envelopes

### 3.1 Pagination Envelopes

#### Cursor-Based Pagination (Event Streams / Notifications / Audit Logs)
Used for append-only, high-throughput time-series data to avoid pagination drift:

```json
{
  "data": [
    {
      "id": "notif-98f2c3d4",
      "userId": "u-42b8e9a1",
      "title": "Circuit Breaker Tripped",
      "category": "system",
      "createdAt": "2026-09-26T12:00:00.000Z"
    }
  ],
  "total": 142,
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA5LTI2VDExOjAwOjAwWiIsImlkIjoibm90aWYtOThmMmMzZDQifQ=="
}
```

#### Offset-Based Pagination (Portfolios / Assets / History)
Used for structured table views and sorted tabular queries:

```json
{
  "items": [
    {
      "id": "port-a1b2c3d4",
      "name": "DeFi Alpha Yield",
      "totalValue": "250000.0000000",
      "status": "active"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "totalItems": 150,
    "totalPages": 8
  }
}
```

### 3.2 Standard Error Response Format (RFC 7807)
All errors emitted by the Trellis API are transformed through `GlobalExceptionFilter` into a structured problem details payload:

```json
{
  "statusCode": 400,
  "timestamp": "2026-09-26T12:00:00.000Z",
  "path": "/api/v1/import/validate",
  "error": "Bad Request",
  "message": "Validation failed: 2 rows contained schema or constraint errors",
  "correlationId": "req-94a2b9a7-4b71-460d-85f0-6a56b797b5e4",
  "details": [
    {
      "row": 3,
      "field": "assetCode",
      "issue": "assetCode must match ^[A-Za-z0-9]{1,12}$"
    },
    {
      "row": 7,
      "field": "balance",
      "issue": "balance cannot be negative"
    }
  ]
}
```

---

## 4. Stellar Network & Data Formatting Rules

To guarantee compatibility with the Stellar distributed ledger and Soroban runtime:

1. **Stellar Public Addresses:** Must conform to StrKey ed25519 public key format (`^G[A-Z2-7]{55}$`, 56 alphanumeric characters).
2. **Transaction Hashes:** Must conform to 64-character lowercase hexadecimal format (`^[a-f0-9]{64}$`).
3. **Asset Quantities:** Represented as fixed-point decimal strings with up to 7 decimal places (1 stroop = `0.0000001` XLM). Floating-point values are prohibited in monetary fields.
4. **Asset Codes:** Alphanumeric asset identifiers of 1–12 characters (e.g., `XLM`, `USDC`, `EURC`).

---

## 5. Core Integration Flows & Endpoints

### 5.1 Flow 1: Stellar Wallet Authentication (SEP-10 Handshake)

#### 1. Request Challenge
- **Endpoint:** `POST /api/v1/auth/challenge`
- **Auth:** None (Public)
- **Request:**
  ```json
  {
    "address": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "message": "Sign this message to authenticate: 9cc3bcab9450390ce5e214045a41e70e6d4a920f2bbc3e5d873c90eadfb7e45c",
    "address": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  }
  ```
- **Failure Response (400 Bad Request - Invalid Address Format):**
  ```json
  {
    "statusCode": 400,
    "timestamp": "2026-09-26T12:00:00.000Z",
    "path": "/api/v1/auth/challenge",
    "error": "Bad Request",
    "message": "Invalid wallet address format. Must be a valid Stellar public key (G...)."
  }
  ```

#### 2. Verify Signature & Issue Token
- **Endpoint:** `POST /api/v1/auth/verify`
- **Auth:** None (Public)
- **Request:**
  ```json
  {
    "message": "Sign this message to authenticate: 9cc3bcab9450390ce5e214045a41e70e6d4a920f2bbc3e5d873c90eadfb7e45c",
    "signature": "3b29ef58a012c8e3b4a2f1c8d7e9b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTQyYjhlOWExIiwicm9sZXMiOlsiVVNFUiJdfQ...",
    "address": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  }
  ```
- **Failure Response (401 Unauthorized - Invalid Signature):**
  ```json
  {
    "statusCode": 401,
    "timestamp": "2026-09-26T12:00:00.000Z",
    "path": "/api/v1/auth/verify",
    "error": "Unauthorized",
    "message": "Cryptographic signature verification failed for provided challenge"
  }
  ```

---

### 5.2 Flow 2: Bulk Data Ingestion Pipeline with Dry-Run & Rollback Guidance

#### 1. Dry-Run Validation Preview
- **Endpoint:** `POST /api/v1/import/validate`
- **Auth:** Bearer JWT (`OPERATOR`, `ADMIN`)
- **Request:**
  ```json
  {
    "entityType": "PORTFOLIO_ASSETS",
    "batchId": "batch-20260926-001",
    "rows": [
      {
        "portfolioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "assetCode": "XLM",
        "balance": "1500.5000000",
        "targetAllocation": 40.0,
        "externalRef": "ext-xlm-001"
      },
      {
        "portfolioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "assetCode": "USDC",
        "balance": "3000.0000000",
        "targetAllocation": 60.0,
        "externalRef": "ext-usdc-002"
      }
    ]
  }
  ```
- **Success Response (200 OK - Dry Run Preview):**
  ```json
  {
    "batchId": "batch-20260926-001",
    "entityType": "PORTFOLIO_ASSETS",
    "status": "VALID",
    "dryRun": true,
    "summary": {
      "totalRows": 2,
      "createdCount": 2,
      "updatedCount": 0,
      "skippedCount": 0,
      "errorCount": 0
    },
    "errors": [],
    "rollbackGuidance": "-- No persistent changes were committed (dryRun: true)"
  }
  ```
- **Failure Response (400 Bad Request - Validation Errors Detected):**
  ```json
  {
    "batchId": "batch-20260926-001",
    "entityType": "PORTFOLIO_ASSETS",
    "status": "FAILED",
    "dryRun": true,
    "summary": {
      "totalRows": 2,
      "createdCount": 0,
      "updatedCount": 0,
      "skippedCount": 0,
      "errorCount": 1
    },
    "errors": [
      {
        "row": 1,
        "field": "assetCode",
        "issue": "assetCode must be 1-12 uppercase alphanumeric characters",
        "rawValue": "invalid_code_12345"
      }
    ],
    "rollbackGuidance": "-- Remediate 1 error before committing batch batch-20260926-001"
  }
  ```

#### 2. Execute Atomic Import Commit
- **Endpoint:** `POST /api/v1/import/execute`
- **Auth:** Bearer JWT (`OPERATOR`, `ADMIN`)
- **Request:**
  ```json
  {
    "entityType": "PORTFOLIO_ASSETS",
    "batchId": "batch-20260926-001",
    "dryRun": false,
    "rows": [
      {
        "portfolioId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "assetCode": "XLM",
        "balance": "1500.5000000",
        "targetAllocation": 40.0,
        "externalRef": "ext-xlm-001"
      }
    ]
  }
  ```
- **Success Response (200 OK - Committed):**
  ```json
  {
    "batchId": "batch-20260926-001",
    "entityType": "PORTFOLIO_ASSETS",
    "status": "COMMITTED",
    "dryRun": false,
    "summary": {
      "totalRows": 1,
      "createdCount": 1,
      "updatedCount": 0,
      "skippedCount": 0,
      "errorCount": 0
    },
    "errors": [],
    "rollbackGuidance": "BEGIN; DELETE FROM portfolio_asset WHERE id IN ('fa12b9c3-4d5e-6f7a-8b9c-0d1e2f3a4b5c'); COMMIT;"
  }
  ```

---

### 5.3 Flow 3: Stellar Payment Reconciliation & Invoicing

#### 1. Ingest Stellar Confirmed Transaction
- **Endpoint:** `POST /api/v1/reconcile/stellar/transactions`
- **Auth:** `X-API-Key` or Bearer JWT
- **Request:**
  ```json
  {
    "transactionId": "d3f28b7e9a014c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
    "ledger": 5249102,
    "sourceAccount": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "destinationAccount": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "amount": "100.0000000",
    "assetCode": "XLM",
    "memo": "INV-2026-001"
  }
  ```
- **Success Response (201 Created / 200 OK):**
  ```json
  {
    "transactionId": "d3f28b7e9a014c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
    "status": "MATCHED",
    "matchedInvoiceId": "INV-2026-001",
    "reconciledAt": "2026-09-26T12:00:00.000Z"
  }
  ```
- **Failure Response (400 Bad Request - Invalid Transaction Hash):**
  ```json
  {
    "statusCode": 400,
    "timestamp": "2026-09-26T12:00:00.000Z",
    "path": "/api/v1/reconcile/stellar/transactions",
    "error": "Bad Request",
    "message": "transactionId must be a 64-character hexadecimal string"
  }
  ```

---

### 5.4 Flow 4: Blockchain Oracle Payload Submission & Verification

#### 1. Create Oracle Payload
- **Endpoint:** `POST /api/v1/oracle/payloads`
- **Auth:** Bearer JWT / API Key
- **Request:**
  ```json
  {
    "payloadType": "PRICE_FEED",
    "data": {
      "symbol": "XLM/USD",
      "price": "0.1452000",
      "timestamp": 1758888000
    }
  }
  ```
- **Success Response (201 Created):**
  ```json
  {
    "id": "e4b8a1c9-7d2f-4a3e-8c1b-9d0e1f2a3b4c",
    "payloadType": "PRICE_FEED",
    "status": "PENDING_SIGNATURE",
    "payloadHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "createdAt": "2026-09-26T12:00:00.000Z"
  }
  ```

#### 2. Submit Signed Payload On-Chain
- **Endpoint:** `POST /api/v1/oracle/payloads/:id/submit`
- **Auth:** Bearer JWT
- **Success Response (200 OK):**
  ```json
  {
    "transactionHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
    "payload": {
      "id": "e4b8a1c9-7d2f-4a3e-8c1b-9d0e1f2a3b4c",
      "status": "SUBMITTED",
      "submittedAt": "2026-09-26T12:00:05.000Z"
    }
  }
  ```
- **Failure Response (404 Not Found - Payload Missing):**
  ```json
  {
    "statusCode": 404,
    "timestamp": "2026-09-26T12:00:00.000Z",
    "path": "/api/v1/oracle/payloads/invalid-uuid/submit",
    "error": "Not Found",
    "message": "Signed payload invalid-uuid not found"
  }
  ```

---

### 5.5 Flow 5: Multi-Channel Notifications with Deduplication & Deep Links

#### 1. Dispatch Critical Notification
- **Endpoint:** `POST /api/v1/notifications/send`
- **Auth:** Bearer JWT / Service Key
- **Request:**
  ```json
  {
    "userId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "title": "Circuit Breaker Activated",
    "body": "Rebalancing halted due to 15% drawdown threshold breach.",
    "category": "system",
    "priority": "critical",
    "deepLink": "/portfolios/3fa85f64-5717-4562-b3fc-2c963f66afa6/circuit-breaker",
    "deduplicationKey": "cb-trip-port-3fa85f64-2026-09-26"
  }
  ```
- **Success Response (201 Created):**
  ```json
  {
    "id": "7b2e1f4a-9c3d-4e5f-8a1b-0c2d3e4f5a6b",
    "userId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "title": "Circuit Breaker Activated",
    "body": "Rebalancing halted due to 15% drawdown threshold breach.",
    "deepLink": "/portfolios/3fa85f64-5717-4562-b3fc-2c963f66afa6/circuit-breaker",
    "deduplicationKey": "cb-trip-port-3fa85f64-2026-09-26",
    "read": false,
    "createdAt": "2026-09-26T12:00:00.000Z"
  }
  ```
- **Duplicate Suppression Behavior (201 Created / Idempotent Return):**
  If a second request with the same `deduplicationKey` is submitted, the existing active notification record is returned idempotently without creating redundant notifications or sending duplicate push/email alerts.

---

## 6. Contract Drift Detection & Automated CI Verification

To guarantee zero contract drift between this documentation, the OpenAPI specification, and the underlying NestJS implementation:

1. **OpenAPI Export:**
   ```bash
   npm run openapi:export
   ```
   Generates a standalone, deterministic OpenAPI 3.0 schema from NestJS reflection metadata into [`docs/openapi.json`](file:///Users/favoureze/Trellis-API/docs/openapi.json).

2. **Contract Drift Test Suite:**
   ```bash
   npm run test:contract
   ```
   Automated Jest suite executing [`src/common/contract/api-contract-drift.spec.ts`](file:///Users/favoureze/Trellis-API/src/common/contract/api-contract-drift.spec.ts), verifying:
   - Route path mappings and HTTP method bindings across all controllers.
   - Schema field invariants and property types (including `deepLink`, `deduplicationKey`, `dryRun`, `rollbackGuidance`).
   - Security schemes (`JWT-auth`, `api-key`).
   - Standard HTTP response codes (200, 201, 400, 401, 403, 404, 409, 429).
