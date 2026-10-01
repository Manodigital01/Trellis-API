import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePaymentOperations1790467200000
  implements MigrationInterface
{
  name = "CreatePaymentOperations1790467200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      CREATE TABLE "payment_operations" (
        "operationId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ownerId" varchar(255) NOT NULL,
        "processorName" varchar(64) NOT NULL,
        "idempotencyKey" varchar(255) NOT NULL,
        "requestFingerprint" varchar(64) NOT NULL,
        "state" varchar(32) NOT NULL DEFAULT 'CREATING',
        "paymentId" varchar(255),
        "createdPayment" jsonb,
        "signedPayload" text,
        "signerAddress" varchar(255),
        "transactionHash" varchar(255),
        "submittedTransaction" jsonb,
        "lastError" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_payment_operations_owner_processor_idempotency"
          UNIQUE ("ownerId", "processorName", "idempotencyKey")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_payment_operations_state_updated"
      ON "payment_operations" ("state", "updatedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_payment_operations_payment_id"
      ON "payment_operations" ("paymentId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payment_operations"`);
  }
}
