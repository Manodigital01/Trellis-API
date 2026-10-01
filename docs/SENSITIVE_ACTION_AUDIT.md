# Sensitive action audit trail

The general audit log (`audit_logs`) records request-level activity. This
module records **business-level** activity: who did what, to which resource,
why, and what changed — for the actions that move value, change access, touch
user data, or alter protocol behaviour.

## Why a separate table

| | `audit_logs` | `sensitive_action_events` |
| --- | --- | --- |
| Unit of record | HTTP request | domain action |
| Written by | request pipeline | the domain service performing the action |
| Retention | 7 years, then purged | **never purged** |
| Integrity | encrypted columns | SHA-256 hash chain |
| Payload | free-form `details` | sanitized `before`/`after` snapshots |

The retention job deletes rows on purpose, which would break a hash chain, so
the tamper-evident trail lives in its own append-only table.

## Covered actions

`SensitiveAction` is the declared catalogue; recording anything else is
rejected, so a new sensitive path cannot be added without an explicit decision
about its scope, whether a reason is mandatory, and whether before/after state
must be captured.

| Scope | Examples |
| --- | --- |
| `authentication` | `auth.login.succeeded`, `auth.login.failed`, `auth.password.changed`, `auth.mfa.reset` |
| `access-control` | `access.role.assigned`, `access.role.revoked`, `access.api-key.revoked`, `access.impersonation.started` |
| `identity` | `identity.user.suspended`, `identity.user.deleted`, `identity.kyc.decision` |
| `treasury` | `treasury.withdrawal.approved`, `treasury.withdrawal.rejected`, `treasury.payout.initiated`, `treasury.wallet.whitelisted` |
| `billing` | `billing.invoice.marked-paid`, `billing.invoice.voided`, `billing.refund.issued`, `billing.credit.adjusted` |
| `reconciliation` | `reconciliation.override`, `reconciliation.invoice.updated` |
| `data-export` | `data.audit.exported`, `data.user.exported` |
| `compliance` | `compliance.retention-hold.placed` |
| `protocol-config` | `config.feature-flag.changed`, `config.emergency-pause.toggled`, `config.contract.upgraded` |
| `portfolio` | `portfolio.record.changed` for portfolio ownership, value, allocation, and holding mutations |

The live list, including which actions require a reason, is served by
`GET /audit-trail/sensitive-actions/catalogue`.

## Recording an event

Call the service **at the domain boundary**, immediately after the action
succeeds (or fails):

```ts
import { SensitiveActionAuditService } from "../audit/sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction } from "../audit/sensitive-actions/sensitive-action.enum";
import { AuditActorType } from "../audit/entities/sensitive-action-event.entity";

constructor(private readonly auditTrail: SensitiveActionAuditService) {}

async assignRole(actor: Actor, userId: string, role: Role) {
  const before = { roles: await this.rolesOf(userId) };
  await this.applyRole(userId, role);

  await this.auditTrail.recordSensitiveAction({
    action: SensitiveAction.ROLE_ASSIGNED,
    actorId: actor.id,
    actorType: AuditActorType.MAINTAINER,
    actorRole: actor.role,
    resourceType: "user",
    resourceId: userId,
    reason: "Support escalation #4471",
    beforeState: before,
    afterState: { roles: [...before.roles, role] },
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });
}
```

Recording is deliberately **not** exposed as a write endpoint: only the code
that performs the action can attribute it.

### Rules the service enforces

* the action must exist in the catalogue, otherwise `400`;
* `actorId` is mandatory, otherwise `400`;
* a **reason** is mandatory for actions flagged `reasonRequired` (approvals,
  role changes, exports, config changes), otherwise `400`;
* `before`/`after` snapshots are only stored for actions flagged
  `capturesState`;
* oversized fields are clipped to their column limits, so a verbose caller
  cannot break the write.

## What is *not* stored

`audit-payload.sanitizer.ts` walks every payload before it is persisted and:

* replaces values of secret-looking keys (`secret`, `token`, `password`,
  `authorization`, `api-key`, `privateKey`, `seed`, `mnemonic`, `signature`,
  `cookie`, `session-id`, `otp`, `pin`, `card-number`, `cvv`, `iban`, `ssn`,
  `refresh-token`, `webhook-secret`, …) with `[REDACTED]`;
* records the redacted paths on the event (`redactedPaths`) so reviewers can see
  that a field existed without seeing its value;
* truncates strings over 500 characters, caps depth at 6, arrays at 100 items;
* replaces reference cycles with `[Circular]` and drops non-JSON values.

Add a new pattern to `SENSITIVE_KEY_PATTERN` when a new secret-bearing field is
introduced.

## Integrity

Every event stores `eventHash` (SHA-256 over the recorded fields) and
`previousHash`, forming a chain ordered by the monotonic `sequence` column. A
durable `sensitive_action_chain_heads` row stores the expected sequence, hash,
and event ID at the chain tip. Verification enforces contiguous sequence
numbers and compares the final event to this head, so deleting the newest rows
is detectable as well as editing, deleting, or reordering interior rows.
Appending fails closed when existing history and its head disagree.
`GET /audit-trail/sensitive-actions/integrity` recomputes the chain and reports
the first broken link:

```json
{
  "valid": true,
  "verified": 1284,
  "brokenAt": null,
  "reason": "Verified 1284 events ending at sequence 1284",
  "verifiedAt": "2026-09-26T12:00:00.000Z"
}
```

An edited, missing, or out-of-order row (including a truncated tail) produces
`valid: false` with `brokenAt` pointing at the offending event or expected
chain tip.

Role assignments and resets record actor, reason, and before/after roles;
rejected conflicting assignments are recorded with `status: failed` and do not
change the role. Portfolio create/update/delete, allocation/status changes,
holding changes, market-price updates, and portfolio value/allocation
recalculations record sanitized before/after snapshots against the owning user.

## Maintainer API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/audit-trail/sensitive-actions` | Query by actor, action, scope, resource, status, and date range (`page`, `limit` ≤ 500). |
| `GET` | `/audit-trail/sensitive-actions/catalogue` | Covered actions, their scope, and their requirements. |
| `GET` | `/audit-trail/sensitive-actions/integrity` | Verify the hash chain. |
| `GET` | `/audit-trail/sensitive-actions/export` | JSON export (≤ 10,000 rows) with the chain status; the export itself is recorded as `data.audit.exported`. |
| `GET` | `/audit-trail/sensitive-actions/resource/:type/:id` | Full timeline for one resource, oldest first. |

Apply the `CreateSensitiveActionChainHead1790553600000` migration before
deployment. It backfills the chain head from the latest existing event; keep
this head row and all `sensitive_action_events` rows in the same protected
backup/restore boundary.

All routes require a JWT **and** the compliance-officer guard.

## Tests

* `audit-payload.sanitizer.spec.ts` — redaction, path reporting, truncation,
  depth/array caps, cycle handling, non-object payloads.
* `sensitive-action-audit.service.spec.ts` — actor attribution and event shape,
  reason enforcement, catalogue enforcement, sanitized snapshots, state
  capture rules, sequence/hash chaining, tamper, interior/tail deletion,
  sequence-gap and missing-head detection, query filters, pagination, resource
  history, and export. Role-change tests cover successful and rejected updates.
