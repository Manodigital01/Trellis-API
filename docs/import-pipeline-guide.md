# Bulk Import Pipeline with Dry-Run Validation and Rollback Guidance

## 1. Overview

The Trellis API bulk import pipeline provides a transactional, idempotent, and memory-efficient (`O(N)` linear processing with `O(1)` index lookups) interface for ingesting portfolio holdings, assets, and configuration data.

### Key Guarantees
1. **Zero-Side-Effect Dry Run:** The dry run mode (`dryRun: true`) evaluates schema rules, foreign key integrity, duplicate collisions, and generates diff previews with **zero persistent database writes**.
2. **External ID Idempotency:** Providing an `externalId` enables idempotent re-imports. Existing records are updated in place rather than duplicated.
3. **Atomic Transaction Boundary:** Live imports run within atomic SQL transactions. If any row fails validation and `allowPartial: false`, the entire transaction is rolled back.
4. **Actionable Rollback Guidance:** In the event of errors or post-import remediation needs, the response contains structured rollback instructions with exact entity IDs and compensation steps.

---

## 2. API Endpoints

### 2.1 Dry-Run Validation (`POST /api/v1/import/validate`)
Validates a batch and returns a preview of what changes would occur.

#### Request Payload
```json
{
  "entityType": "PORTFOLIO_ASSETS",
  "dryRun": true,
  "rows": [
    {
      "portfolioId": "b1a2c3d4-0000-0000-0000-000000000001",
      "symbol": "XLM",
      "amount": 5000.0,
      "currentPrice": 0.145,
      "targetAllocation": 50.0,
      "externalId": "ext-asset-001"
    },
    {
      "portfolioId": "b1a2c3d4-0000-0000-0000-000000000001",
      "symbol": "USDC",
      "amount": 2500.0,
      "currentPrice": 1.0,
      "targetAllocation": 50.0,
      "externalId": "ext-asset-002"
    }
  ],
  "options": {
    "updateExisting": true,
    "allowPartial": false
  }
}
```

#### Response (200 OK)
```json
{
  "dryRun": true,
  "entityType": "PORTFOLIO_ASSETS",
  "totalRows": 2,
  "createCount": 2,
  "updateCount": 0,
  "skipCount": 0,
  "errorCount": 0,
  "isSuccess": true,
  "preview": [
    {
      "rowIndex": 1,
      "externalId": "ext-asset-001",
      "action": "CREATE",
      "summary": "Create new asset \"XLM\" under portfolio b1a2c3d4-0000-0000-0000-000000000001",
      "after": {
        "symbol": "XLM",
        "amount": 5000.0,
        "currentPrice": 0.145,
        "targetAllocation": 50.0
      }
    }
  ],
  "errors": [],
  "executionTimeMs": 42
}
```

---

## 3. Error Handling and Remediation

### Common Error Types

| Error Condition | Cause | Remediation |
| :--- | :--- | :--- |
| **Batch Duplicate `externalId`** | The same `externalId` appeared more than once in the same import payload. | Consolidate duplicate rows or assign distinct external IDs. |
| **Missing Foreign Key** | The `portfolioId` does not exist in the database. | Create the target portfolio prior to importing assets. |
| **Out-of-Bounds Value** | `amount < 0` or `targetAllocation > 100`. | Normalize numerical fields to valid domain ranges. |

### Partial Import & Rollback Guidance
When an import commits with `allowPartial: true` (or when maintainers need to roll back live changes), the `rollbackGuidance` envelope provides:
```json
{
  "rollbackGuidance": {
    "transactionId": "9fa8c12b-3456-4789-abcd-0123456789ab",
    "snapshotTimestamp": "2026-09-26T13:00:00.000Z",
    "affectedRecordIds": ["pa-001", "pa-002"],
    "remediationSteps": [
      "To revert created records, execute DELETE FROM portfolio_assets WHERE id IN ('pa-001', 'pa-002');"
    ],
    "rollbackInstructions": "If this live batch needs to be rolled back manually, utilize the affected record IDs listed above."
  }
}
```
