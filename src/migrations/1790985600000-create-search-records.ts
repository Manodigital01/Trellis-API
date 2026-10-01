import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSearchRecords1790985600000 implements MigrationInterface {
  name = "CreateSearchRecords1790985600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "search_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ownerId" uuid NOT NULL,
        "title" varchar(255) NOT NULL,
        "content" text NOT NULL,
        "visibility" varchar(16) NOT NULL DEFAULT 'private',
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_search_records" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_search_records_visibility" CHECK ("visibility" IN ('private', 'public'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_search_records_owner_visibility" ON "search_records" ("ownerId", "visibility")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_search_records_owner_visibility"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "search_records"`);
  }
}
