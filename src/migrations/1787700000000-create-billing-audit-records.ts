import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates `billing_audit_records` (issue #82).
 *
 * A mid-cycle plan change moves money in both directions, so the ledger of those
 * changes has to outlive the request that made them. The table is created with
 * its own indexes rather than a bare `CREATE TABLE` so the two read paths the API
 * exposes — an account's history in effective order, and a time-window lookup —
 * are both index-supported from the first deploy.
 *
 * The `lineItems` column is `jsonb`: the detail is a small, self-describing
 * array of proration line items that is always read and written whole, so a
 * relational decomposition would buy nothing but joins.
 */
export class CreateBillingAuditRecords1787700000000
  implements MigrationInterface
{
  name = "CreateBillingAuditRecords1787700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `gen_random_uuid()` is the same default TypeORM emits for the entity's
    // uuid primary key, so the table and the ORM agree on generated ids.
    await queryRunner.query(
      `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing_audit_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "accountId" varchar(255) NOT NULL,
        "fromPlanId" varchar(50) NOT NULL,
        "toPlanId" varchar(50) NOT NULL,
        "direction" varchar(20) NOT NULL,
        "effectiveAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cycleStart" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cycleEnd" TIMESTAMP WITH TIME ZONE NOT NULL,
        "totalCycleDays" double precision NOT NULL,
        "remainingDays" double precision NOT NULL,
        "remainingFraction" double precision NOT NULL,
        "unusedCreditCents" integer NOT NULL DEFAULT 0,
        "newPlanChargeCents" integer NOT NULL DEFAULT 0,
        "netAmountCents" integer NOT NULL DEFAULT 0,
        "currency" varchar(3) NOT NULL DEFAULT 'usd',
        "lineItems" jsonb NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP,
        CONSTRAINT "PK_billing_audit_records" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_audit_records_account_id" ON "billing_audit_records" ("accountId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_audit_records_account_effective" ON "billing_audit_records" ("accountId", "effectiveAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_audit_records_account_created" ON "billing_audit_records" ("accountId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_billing_audit_records_account_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_billing_audit_records_account_effective"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_billing_audit_records_account_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "billing_audit_records"`);
  }
}
