import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PortfolioAsset } from "../investment/portfolio/entities/portfolio-asset.entity";
import {
  DEFAULT_ASSET_SEARCH_LIMIT,
  MAX_ASSET_SEARCH_LIMIT,
} from "./dto/asset-search-query.dto";
import { AssetSearchQueryDto } from "./dto/asset-search-query.dto";
import {
  AssetSearchFuzzyMode,
  AssetSearchHit,
  AssetSearchMatch,
  AssetSearchResponse,
} from "./dto/asset-search-response.dto";
import {
  DEFAULT_MAX_EDIT_DISTANCE,
  DEFAULT_MIN_SIMILARITY,
  combineFuzzyRelevance,
  escapeLikePattern,
  normalizeAssetQuery,
  scoreTypoMatch,
} from "./fuzzy-match";

/** Extensions that back the tolerant stage. */
const FUZZY_EXTENSIONS = ["pg_trgm", "fuzzystrmatch"] as const;
/** `undefined_function` — `similarity()`/`levenshtein()` missing. */
const UNDEFINED_FUNCTION = "42883";
/** `undefined_object` — extension missing entirely. */
const UNDEFINED_OBJECT = "42704";
/** Rows pulled into memory at most for the in-process ranking fallback. */
const CANDIDATE_WINDOW = 250;

/**
 * Fixed relevance ladder for the exact stage. The database orders rows by this
 * ladder before `LIMIT`, so the best matches are the ones that survive the
 * page, and the same numbers are what the response reports as `relevance`.
 */
export const STRUCTURED_RELEVANCE = {
  tickerExact: 1,
  nameExact: 0.95,
  tickerPrefix: 0.9,
  namePrefix: 0.8,
  tickerContains: 0.6,
  nameContains: 0.5,
} as const;

/**
 * The ladder expressed as SQL, used as the `ORDER BY` of the exact stage. It
 * has to be the ordering (not a post-hoc sort) so `LIMIT` keeps the strongest
 * matches: ordering by ticker alone would let three weak substring matches
 * occupy the page ahead of the exact one.
 */
const STRUCTURED_MATCH_RANK_SQL =
  "CASE" +
  " WHEN LOWER(asset.ticker) = :exact THEN 0" +
  " WHEN LOWER(asset.name) = :exact THEN 1" +
  " WHEN asset.ticker ILIKE :prefix ESCAPE '\\' THEN 2" +
  " WHEN asset.name ILIKE :prefix ESCAPE '\\' THEN 3" +
  " WHEN asset.ticker ILIKE :contains ESCAPE '\\' THEN 4" +
  " ELSE 5 END";

export interface AssetSearchInput {
  query: string;
  userId: string;
  portfolioId?: string;
  limit: number;
  minSimilarity?: number;
  maxDistance?: number;
}

/**
 * Typo-tolerant asset lookup.
 *
 * The lookup runs in two stages. The cheap, index-friendly stage matches the
 * query against `ticker`/`name` exactly, by prefix and as a substring, which is
 * what the previous `LIKE`-only behaviour did. Only when that stage cannot fill
 * the requested page does the tolerant stage run: with `pg_trgm` +
 * `fuzzystrmatch` installed the ranking happens in PostgreSQL, otherwise a
 * bounded candidate window is ranked in process with the same similarity and
 * edit-distance thresholds, so `Stelar`/`Stellar` and `ETTH`/`ETH` resolve on a
 * database where the extensions could not be installed.
 */
@Injectable()
export class AssetSearchService {
  private readonly logger = new Logger(AssetSearchService.name);
  private fuzzyExtensionsAvailable: Promise<boolean> | null = null;

  constructor(
    @InjectRepository(PortfolioAsset)
    private readonly assets: Repository<PortfolioAsset>,
  ) {}

  async search(
    dto: AssetSearchQueryDto,
    userId = "",
  ): Promise<AssetSearchResponse> {
    const query = normalizeAssetQuery(dto?.q);
    const limit = this.clampLimit(dto?.limit);

    if (!query) {
      return {
        query: dto?.q ?? "",
        normalizedQuery: "",
        fuzzyMode: "none",
        total: 0,
        results: [],
      };
    }

    const structured = await this.searchStructured(
      query,
      userId,
      dto?.portfolioId,
      limit,
    );

    if (dto?.exactOnly || structured.length >= limit) {
      const results = structured.slice(0, limit);
      return {
        query: dto?.q ?? "",
        normalizedQuery: query,
        fuzzyMode: "none",
        total: results.length,
        results,
      };
    }

    const tolerant = await this.searchTolerant({
      query,
      userId,
      portfolioId: dto?.portfolioId,
      limit: limit - structured.length,
      minSimilarity: dto?.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      maxDistance: dto?.maxDistance ?? DEFAULT_MAX_EDIT_DISTANCE,
    });

    const results = this.merge(structured, tolerant.hits).slice(0, limit);

    return {
      query: dto?.q ?? "",
      normalizedQuery: query,
      fuzzyMode: tolerant.mode,
      total: results.length,
      results,
    };
  }

  /**
   * Stage 1: exact / prefix / substring matches, all servable from a btree
   * index on `LOWER(ticker)` and the trigram indexes added by migration
   * `1787400000000`.
   */
  private async searchStructured(
    query: string,
    userId: string,
    portfolioId: string | undefined,
    limit: number,
  ): Promise<AssetSearchHit[]> {
    const pattern = escapeLikePattern(query);

    const qb = this.assets
      .createQueryBuilder("asset")
      .innerJoin("asset.portfolio", "portfolio")
      .where("asset.ticker IS NOT NULL")
      .andWhere("asset.deletedAt IS NULL")
      .andWhere("portfolio.deletedAt IS NULL")
      .andWhere("portfolio.userId = :userId", { userId })
      .andWhere(
        "(LOWER(asset.ticker) = :exact" +
          " OR LOWER(asset.name) = :exact" +
          " OR asset.ticker ILIKE :prefix ESCAPE '\\'" +
          " OR asset.name ILIKE :prefix ESCAPE '\\'" +
          " OR asset.ticker ILIKE :contains ESCAPE '\\'" +
          " OR asset.name ILIKE :contains ESCAPE '\\')",
      )
      .setParameters({
        exact: query,
        prefix: `${pattern}%`,
        contains: `%${pattern}%`,
      })
      .orderBy(STRUCTURED_MATCH_RANK_SQL, "ASC")
      .addOrderBy("asset.ticker", "ASC")
      .take(limit);

    if (portfolioId) {
      qb.andWhere("asset.portfolioId = :portfolioId", { portfolioId });
    }

    const rows = await qb.getMany();

    return rows
      .map((row) => this.toStructuredHit(row, query))
      .sort(
        (left, right) =>
          right.relevance - left.relevance ||
          left.ticker.localeCompare(right.ticker),
      );
  }

  /** Stage 2: pick the best tolerant strategy this database supports. */
  private async searchTolerant(
    input: AssetSearchInput,
  ): Promise<{ mode: AssetSearchFuzzyMode; hits: AssetSearchHit[] }> {
    if (!(await this.hasFuzzyExtensions())) {
      return {
        mode: "levenshtein",
        hits: await this.searchViaLevenshtein(input),
      };
    }

    try {
      return { mode: "trigram", hits: await this.searchViaTrigram(input) };
    } catch (error) {
      if (!this.isMissingFuzzyFunction(error)) {
        throw error;
      }

      // The probe said the functions were there and they no longer are (the
      // extension was dropped, or the role cannot see it): remember that so the
      // next request skips the doomed query, and report the strategy that
      // actually produced these results.
      this.fuzzyExtensionsAvailable = Promise.resolve(false);
      this.logger.warn(
        `pg_trgm/fuzzystrmatch became unavailable (${this.describeError(error)}); ` +
          "ranking asset matches in process instead",
      );

      return {
        mode: "levenshtein",
        hits: await this.searchViaLevenshtein(input),
      };
    }
  }

  /**
   * Rank with `pg_trgm`'s `similarity()` and `fuzzystrmatch`'s
   * `levenshtein()`, both GIN/btree-backed, so the database does the work.
   */
  private async searchViaTrigram(
    input: AssetSearchInput,
  ): Promise<AssetSearchHit[]> {
    const {
      query,
      userId,
      portfolioId,
      limit,
      minSimilarity = DEFAULT_MIN_SIMILARITY,
      maxDistance = DEFAULT_MAX_EDIT_DISTANCE,
    } = input;

    const score =
      "GREATEST(similarity(LOWER(asset.ticker), :query), similarity(LOWER(asset.name), :query))";
    // The edit-distance arm only counts for a column whose first character
    // matches, so two substitutions on a short ticker ("eth" vs "btc") cannot
    // pull in an unrelated asset. LEAST ignores the NULLs that leaves behind,
    // and an all-NULL result makes `<= :maxDistance` NULL rather than true.
    const distance =
      "LEAST(" +
      "CASE WHEN LEFT(LOWER(asset.ticker), 1) = :initial THEN levenshtein(LOWER(asset.ticker), :query) END," +
      " CASE WHEN LEFT(LOWER(asset.name), 1) = :initial THEN levenshtein(LOWER(asset.name), :query) END" +
      ")";

    const qb = this.assets
      .createQueryBuilder("asset")
      .innerJoin("asset.portfolio", "portfolio")
      .addSelect(score, "relevance_score")
      .addSelect(distance, "edit_distance")
      .where("asset.ticker IS NOT NULL")
      .andWhere("asset.deletedAt IS NULL")
      .andWhere("portfolio.deletedAt IS NULL")
      .andWhere("portfolio.userId = :userId", { userId })
      .andWhere(`(${score} >= :minSimilarity OR ${distance} <= :maxDistance)`)
      .setParameters({
        query,
        initial: query.charAt(0),
        minSimilarity,
        maxDistance,
      })
      .orderBy("relevance_score", "DESC")
      .addOrderBy("edit_distance", "ASC")
      .take(limit);

    if (portfolioId) {
      qb.andWhere("asset.portfolioId = :portfolioId", { portfolioId });
    }

    const { entities, raw } = await qb.getRawAndEntities();

    return entities
      .map((entity, index) => {
        const row = (raw?.[index] ?? {}) as Record<string, unknown>;
        const relevance = combineFuzzyRelevance(
          Number(row.relevance_score ?? 0),
          Number(row.edit_distance ?? Number.MAX_SAFE_INTEGER),
        );

        return this.toHit(entity, relevance, "trigram");
      })
      .sort((left, right) => right.relevance - left.relevance);
  }

  /**
   * In-process fallback. A bounded SQL window (same leading character, or the
   * query as a substring) is ranked locally with the same thresholds the SQL
   * stage would have applied, so behaviour stays consistent when the database
   * cannot install the extensions.
   */
  private async searchViaLevenshtein(
    input: AssetSearchInput,
  ): Promise<AssetSearchHit[]> {
    const {
      query,
      userId,
      portfolioId,
      limit,
      minSimilarity = DEFAULT_MIN_SIMILARITY,
      maxDistance = DEFAULT_MAX_EDIT_DISTANCE,
    } = input;
    const options = { minSimilarity, maxDistance };
    const escaped = escapeLikePattern(query);

    const qb = this.assets
      .createQueryBuilder("asset")
      .innerJoin("asset.portfolio", "portfolio")
      .where("asset.ticker IS NOT NULL")
      .andWhere("asset.deletedAt IS NULL")
      .andWhere("portfolio.deletedAt IS NULL")
      .andWhere("portfolio.userId = :userId", { userId })
      .andWhere(
        "(asset.ticker ILIKE :window ESCAPE '\\'" +
          " OR asset.name ILIKE :window ESCAPE '\\'" +
          " OR asset.ticker ILIKE :contains ESCAPE '\\'" +
          " OR asset.name ILIKE :contains ESCAPE '\\')",
      )
      .setParameters({
        window: `${escapeLikePattern(query.slice(0, 1))}%`,
        contains: `%${escaped}%`,
      })
      .orderBy("asset.ticker", "ASC")
      .take(CANDIDATE_WINDOW);

    if (portfolioId) {
      qb.andWhere("asset.portfolioId = :portfolioId", { portfolioId });
    }

    const candidates = await qb.getMany();

    return candidates
      .map((candidate) => {
        const tickerScore = scoreTypoMatch(query, candidate.ticker, options);
        const nameScore = scoreTypoMatch(query, candidate.name, options);
        const relevance = Math.max(tickerScore ?? 0, nameScore ?? 0);

        return { candidate, relevance };
      })
      .filter((entry) => entry.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance)
      .slice(0, limit)
      .map((entry) =>
        this.toHit(entry.candidate, entry.relevance, "levenshtein"),
      );
  }

  /**
   * Probe once per process whether the tolerant stage can run in SQL. The
   * migration creates both extensions; this is the belt-and-braces path for a
   * deployment that skipped it (or a role without `CREATE` on the database).
   */
  private hasFuzzyExtensions(): Promise<boolean> {
    if (!this.fuzzyExtensionsAvailable) {
      this.fuzzyExtensionsAvailable = this.probeFuzzyExtensions();
    }

    return this.fuzzyExtensionsAvailable;
  }

  private async probeFuzzyExtensions(): Promise<boolean> {
    try {
      for (const extension of FUZZY_EXTENSIONS) {
        await this.assets.query(
          `CREATE EXTENSION IF NOT EXISTS "${extension}"`,
        );
      }

      return true;
    } catch (error) {
      this.logger.warn(
        `pg_trgm/fuzzystrmatch are unavailable (${this.describeError(error)}); ` +
          "asset search falls back to in-process similarity ranking",
      );

      return false;
    }
  }

  /** Keep the most relevant copy of an asset found by both stages. */
  private merge(
    primary: AssetSearchHit[],
    secondary: AssetSearchHit[],
  ): AssetSearchHit[] {
    const byId = new Map<string, AssetSearchHit>();

    for (const hit of [...primary, ...secondary]) {
      const existing = byId.get(hit.id);

      if (!existing || hit.relevance > existing.relevance) {
        byId.set(hit.id, hit);
      }
    }

    return [...byId.values()].sort(
      (left, right) =>
        right.relevance - left.relevance ||
        left.ticker.localeCompare(right.ticker),
    );
  }

  private toStructuredHit(
    asset: PortfolioAsset,
    query: string,
  ): AssetSearchHit {
    const ticker = (asset.ticker ?? "").toLowerCase();
    const name = (asset.name ?? "").toLowerCase();

    if (ticker === query) {
      return this.toHit(asset, STRUCTURED_RELEVANCE.tickerExact, "exact");
    }

    if (name === query) {
      return this.toHit(asset, STRUCTURED_RELEVANCE.nameExact, "exact");
    }

    if (ticker.startsWith(query)) {
      return this.toHit(asset, STRUCTURED_RELEVANCE.tickerPrefix, "prefix");
    }

    if (name.startsWith(query)) {
      return this.toHit(asset, STRUCTURED_RELEVANCE.namePrefix, "prefix");
    }

    if (ticker.includes(query)) {
      return this.toHit(asset, STRUCTURED_RELEVANCE.tickerContains, "contains");
    }

    return this.toHit(asset, STRUCTURED_RELEVANCE.nameContains, "contains");
  }

  private toHit(
    asset: PortfolioAsset,
    relevance: number,
    match: AssetSearchMatch,
  ): AssetSearchHit {
    return {
      id: asset.id,
      ticker: asset.ticker,
      name: asset.name,
      chain: asset.chain,
      type: asset.type,
      portfolioId: asset.portfolioId,
      relevance: Math.round(relevance * 10000) / 10000,
      match,
    };
  }

  private clampLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return DEFAULT_ASSET_SEARCH_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(limit), 1), MAX_ASSET_SEARCH_LIMIT);
  }

  private isMissingFuzzyFunction(error: unknown): boolean {
    const code =
      (error as { code?: string })?.code ??
      (error as { driverError?: { code?: string } })?.driverError?.code;

    return code === UNDEFINED_FUNCTION || code === UNDEFINED_OBJECT;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
