import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInboundWebhookReplayKeys1791072000000 implements MigrationInterface {
  name = "AddInboundWebhookReplayKeys1791072000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "webhook_events"
        ADD COLUMN IF NOT EXISTS "sourceSubscriptionId" uuid,
        ADD COLUMN IF NOT EXISTS "externalEventId" varchar(255)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_webhook_events_subscription_external_id"
        ON "webhook_events" ("sourceSubscriptionId", "externalEventId")
        WHERE "sourceSubscriptionId" IS NOT NULL AND "externalEventId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_webhook_events_subscription_external_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "webhook_events"
        DROP COLUMN IF EXISTS "externalEventId",
        DROP COLUMN IF EXISTS "sourceSubscriptionId"
    `);
  }
}
