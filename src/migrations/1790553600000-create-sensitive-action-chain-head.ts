import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSensitiveActionChainHead1790553600000
  implements MigrationInterface
{
  name = "CreateSensitiveActionChainHead1790553600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensitive_action_chain_heads" (
        "id" varchar(32) PRIMARY KEY,
        "sequence" bigint NOT NULL,
        "eventHash" varchar(64) NOT NULL,
        "lastEventId" varchar(255) NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CK_sensitive_action_chain_head_global"
          CHECK ("id" = 'global')
      )
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.sensitive_action_events') IS NOT NULL THEN
          EXECUTE '
            INSERT INTO "sensitive_action_chain_heads"
              ("id", "sequence", "eventHash", "lastEventId")
            SELECT ''global'', "sequence", "eventHash", "id"::varchar
            FROM "sensitive_action_events"
            ORDER BY "sequence" DESC
            LIMIT 1
            ON CONFLICT ("id") DO NOTHING
          ';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sensitive_action_chain_heads"`);
  }
}
