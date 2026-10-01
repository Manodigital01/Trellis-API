import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `familyId` to `refresh_tokens` (issue #144).
 *
 * Refresh-token rotation already revoked the token it replaced, but nothing
 * linked the chain, so a replayed token was indistinguishable from a forged
 * one: both simply failed to match `revoked = false`. The family id lets a
 * replay be *recognised* — the presented token exists and is already revoked —
 * which is the signal that triggers revoking the whole family.
 *
 * The column is nullable so existing rows stay valid. A token with no family
 * still works; it just cannot participate in family-wide revocation, which is
 * correct for a token issued before this migration rather than a loss.
 */
export class AddRefreshTokenFamily1787600000000 implements MigrationInterface {
  name = "AddRefreshTokenFamily1787600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD "familyId" uuid`,
    );
    // Reuse revocations are detected by looking up a token regardless of its
    // revoked flag, then revoking its family. The index serves that lookup and
    // the family-wide revoke that follows it.
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_family_id" ON "refresh_tokens" ("familyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_refresh_tokens_family_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "familyId"`,
    );
  }
}
