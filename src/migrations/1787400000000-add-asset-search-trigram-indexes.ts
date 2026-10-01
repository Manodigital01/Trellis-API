import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Indexes backing the typo-tolerant asset lookup in `src/search`.
 *
 * `similarity()` (pg_trgm) and `levenshtein()` (fuzzystrmatch) are what turn a
 * near-miss like `Stelar` or `ETTH` into a match. Without the GIN trigram
 * indexes the similarity filter has to sequential-scan `portfolio_assets`, and
 * without the expression index the exact/prefix stage cannot use an index for
 * the case-insensitive comparison.
 */
export class AddAssetSearchTrigramIndexes1787400000000
  implements MigrationInterface
{
  name = "AddAssetSearchTrigramIndexes1787400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"`);

    // GIN trigram indexes: serve `similarity(ticker|name, $1) >= threshold`.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_portfolio_assets_ticker_trgm"
      ON "portfolio_assets" USING gin ("ticker" gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_portfolio_assets_name_trgm"
      ON "portfolio_assets" USING gin ("name" gin_trgm_ops)
    `);

    // Expression index: serves the exact / prefix stage, which compares and
    // matches on LOWER(ticker) rather than the raw column.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_portfolio_assets_ticker_lower"
      ON "portfolio_assets" (LOWER("ticker"))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_portfolio_assets_ticker_lower"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_portfolio_assets_name_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_portfolio_assets_ticker_trgm"`,
    );

    // The extensions are intentionally left installed: they are database-wide
    // objects, other objects may depend on them, and dropping them cascades.
  }
}
