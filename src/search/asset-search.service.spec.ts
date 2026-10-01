import { Logger } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { PortfolioAsset } from "../investment/portfolio/entities/portfolio-asset.entity";
import { AssetSearchService } from "./asset-search.service";
import { AssetSearchQueryDto } from "./dto/asset-search-query.dto";

interface QueryBuilderStub {
  where: jest.Mock;
  andWhere: jest.Mock;
  innerJoin: jest.Mock;
  addSelect: jest.Mock;
  setParameters: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getMany: jest.Mock;
  getRawAndEntities: jest.Mock;
}

const makeQueryBuilder = (
  result: {
    many?: PortfolioAsset[];
    rawAndEntities?: { entities: PortfolioAsset[]; raw: any[] };
    throwOnRaw?: unknown;
  } = {},
): QueryBuilderStub => ({
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  setParameters: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  addOrderBy: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getMany: jest.fn().mockResolvedValue(result.many ?? []),
  getRawAndEntities: jest.fn(async () => {
    if (result.throwOnRaw) {
      throw result.throwOnRaw;
    }

    return result.rawAndEntities ?? { entities: [], raw: [] };
  }),
});

const makeRepository = ({
  queue = [],
  extensions = "available",
}: {
  queue?: QueryBuilderStub[];
  extensions?: "available" | "unavailable";
} = {}) => {
  const createQueryBuilder = jest.fn();
  queue.forEach((builder) => createQueryBuilder.mockReturnValueOnce(builder));

  if (queue.length > 0) {
    // Any further call reuses the last stub, so a stage the test did not
    // expect shows up as an assertion failure rather than a crash.
    createQueryBuilder.mockReturnValue(queue[queue.length - 1]);
  }

  const query = jest.fn(async () => {
    if (extensions === "unavailable") {
      throw Object.assign(
        new Error("permission denied to create extension pg_trgm"),
        { code: "42501" },
      );
    }

    return [];
  });

  return { createQueryBuilder, query };
};

const asset = (overrides: Partial<PortfolioAsset>): PortfolioAsset =>
  ({
    id: "asset-1",
    ticker: "ETH",
    name: "Ethereum",
    chain: "ethereum",
    type: "cryptocurrency",
    portfolioId: "portfolio-1",
    ...overrides,
  }) as PortfolioAsset;

const sqlOf = (builder: QueryBuilderStub): string =>
  [...builder.where.mock.calls, ...builder.andWhere.mock.calls]
    .map(([statement]) => String(statement))
    .join("\n");

const buildService = async (
  repository: unknown,
): Promise<AssetSearchService> => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AssetSearchService,
      { provide: getRepositoryToken(PortfolioAsset), useValue: repository },
    ],
  }).compile();

  return module.get(AssetSearchService);
};

const query = (overrides: Partial<AssetSearchQueryDto> = {}) =>
  ({ q: "eth", ...overrides }) as AssetSearchQueryDto;

describe("AssetSearchService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  describe("structured stage", () => {
    it("ranks an exact ticker match first and skips the tolerant stage when the page is full", async () => {
      const structured = makeQueryBuilder({
        many: [asset({ id: "eth", ticker: "ETH", name: "Ethereum" })],
      });
      const repository = makeRepository({ queue: [structured] });
      const service = await buildService(repository);

      const response = await service.search(query({ limit: 1 }));

      expect(response.fuzzyMode).toBe("none");
      expect(response.normalizedQuery).toBe("eth");
      expect(response.results).toEqual([
        {
          id: "eth",
          ticker: "ETH",
          name: "Ethereum",
          chain: "ethereum",
          type: "cryptocurrency",
          portfolioId: "portfolio-1",
          relevance: 1,
          match: "exact",
        },
      ]);
      expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(repository.query).not.toHaveBeenCalled();
    });

    it("orders exact, prefix and substring matches by the relevance ladder", async () => {
      const structured = makeQueryBuilder({
        many: [
          asset({ id: "bond", ticker: "BONDX", name: "the eth bond" }),
          asset({ id: "weth", ticker: "WETH", name: "Wrapped Ether" }),
          asset({ id: "classic", ticker: "XYZ2", name: "Ethereum classic" }),
          asset({ id: "ethl", ticker: "ETHL", name: "Ether liquid" }),
          asset({ id: "eth-name", ticker: "XYZ", name: "ETH" }),
          asset({ id: "eth", ticker: "ETH", name: "Ethereum" }),
        ],
      });
      const service = await buildService(
        makeRepository({ queue: [structured] }),
      );

      const response = await service.search(query({ limit: 6 }));

      expect(
        response.results.map((hit) => [hit.id, hit.match, hit.relevance]),
      ).toEqual([
        ["eth", "exact", 1],
        ["eth-name", "exact", 0.95],
        ["ethl", "prefix", 0.9],
        ["classic", "prefix", 0.8],
        ["weth", "contains", 0.6],
        ["bond", "contains", 0.5],
      ]);
    });

    it("matches case-insensitively with an escaped LIKE pattern", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const service = await buildService(
        makeRepository({ queue: [structured] }),
      );

      await service.search(query({ q: "  Stell_ar%  ", exactOnly: true }));

      expect(sqlOf(structured)).toContain("LOWER(asset.ticker) = :exact");
      expect(sqlOf(structured)).toContain(
        "asset.ticker ILIKE :prefix ESCAPE '\\'",
      );
      expect(sqlOf(structured)).toContain("asset.deletedAt IS NULL");
      expect(structured.setParameters).toHaveBeenCalledWith({
        exact: "stell_ar%",
        prefix: "stell\\_ar\\%%",
        contains: "%stell\\_ar\\%%",
      });
    });

    it("orders in SQL by the match ladder so LIMIT keeps the strongest matches", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const service = await buildService(
        makeRepository({ queue: [structured] }),
      );

      await service.search(query({ q: "eth", exactOnly: true }));

      const [rankSql, direction] = structured.orderBy.mock.calls[0];
      expect(rankSql).toContain(
        "CASE WHEN LOWER(asset.ticker) = :exact THEN 0",
      );
      expect(rankSql).toContain("LOWER(asset.name) = :exact THEN 1");
      expect(rankSql).toContain("ILIKE :prefix");
      expect(rankSql).toContain("ILIKE :contains");
      expect(direction).toBe("ASC");
      expect(structured.addOrderBy).toHaveBeenCalledWith("asset.ticker", "ASC");
    });

    it("scopes the lookup to one portfolio when asked", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        rawAndEntities: { entities: [], raw: [] },
      });
      const service = await buildService(
        makeRepository({ queue: [structured, fuzzy] }),
      );

      await service.search(query({ portfolioId: "portfolio-9" }));

      expect(structured.andWhere).toHaveBeenCalledWith(
        "asset.portfolioId = :portfolioId",
        { portfolioId: "portfolio-9" },
      );
      expect(fuzzy.andWhere).toHaveBeenCalledWith(
        "asset.portfolioId = :portfolioId",
        { portfolioId: "portfolio-9" },
      );
    });

    it("filters every result to a live portfolio owned by the authenticated user", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const service = await buildService(
        makeRepository({ queue: [structured] }),
      );

      await service.search(query({ exactOnly: true }), "owner-7");

      expect(structured.andWhere).toHaveBeenCalledWith(
        "portfolio.userId = :userId",
        { userId: "owner-7" },
      );
      expect(sqlOf(structured)).toContain("portfolio.deletedAt IS NULL");
    });
  });

  describe("tolerant stage (pg_trgm available)", () => {
    it("falls back to trigram similarity and edit distance when exact search finds nothing", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        rawAndEntities: {
          // Deliberately out of order: the service must rank by relevance.
          entities: [
            asset({ id: "btc", ticker: "BTC", name: "Bitcoin" }),
            asset({ id: "xlm", ticker: "XLM", name: "Stellar Lumens" }),
          ],
          raw: [
            { relevance_score: "0.11", edit_distance: null },
            { relevance_score: "0.67", edit_distance: "1" },
          ],
        },
      });
      const repository = makeRepository({ queue: [structured, fuzzy] });
      const service = await buildService(repository);

      const response = await service.search(query({ q: "stelar" }));

      expect(response.fuzzyMode).toBe("trigram");
      expect(
        response.results.map((hit) => [hit.ticker, hit.match, hit.relevance]),
      ).toEqual([
        ["XLM", "trigram", 0.67],
        ["BTC", "trigram", 0.11],
      ]);

      const fuzzySql = sqlOf(fuzzy);
      expect(fuzzySql).toContain("similarity(LOWER(asset.ticker), :query)");
      expect(fuzzySql).toContain("levenshtein(LOWER(asset.ticker), :query)");
      // Short-ticker guard: the distance arm needs a matching first character.
      expect(fuzzySql).toContain("LEFT(LOWER(asset.ticker), 1) = :initial");
      expect(fuzzy.setParameters).toHaveBeenCalledWith({
        query: "stelar",
        initial: "s",
        minSimilarity: 0.2,
        maxDistance: 2,
      });
      expect(fuzzy.orderBy).toHaveBeenCalledWith("relevance_score", "DESC");
      expect(fuzzy.addOrderBy).toHaveBeenCalledWith("edit_distance", "ASC");

      expect(repository.query).toHaveBeenCalledWith(
        'CREATE EXTENSION IF NOT EXISTS "pg_trgm"',
      );
      expect(repository.query).toHaveBeenCalledWith(
        'CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch"',
      );
    });

    it("forwards caller-supplied thresholds", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        rawAndEntities: { entities: [], raw: [] },
      });
      const service = await buildService(
        makeRepository({ queue: [structured, fuzzy] }),
      );

      await service.search(query({ minSimilarity: 0.45, maxDistance: 1 }));

      expect(fuzzy.setParameters).toHaveBeenCalledWith({
        query: "eth",
        initial: "e",
        minSimilarity: 0.45,
        maxDistance: 1,
      });
    });

    it("probes the extensions once per process", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        rawAndEntities: { entities: [], raw: [] },
      });
      const repository = makeRepository({ queue: [structured, fuzzy] });
      const service = await buildService(repository);

      await service.search(query());
      await service.search(query());

      // Two CREATE EXTENSION statements, once — not once per request.
      expect(repository.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("tolerant stage (extensions unavailable)", () => {
    it("ranks a bounded candidate window in process and reports the fallback mode", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const window = makeQueryBuilder({
        many: [
          asset({ id: "xlm", ticker: "XLM", name: "Stellar Lumens" }),
          asset({ id: "btc", ticker: "BTC", name: "Bitcoin" }),
          asset({ id: "eth", ticker: "ETH", name: "Ethereum" }),
        ],
      });
      const repository = makeRepository({
        queue: [structured, window],
        extensions: "unavailable",
      });
      const service = await buildService(repository);

      const response = await service.search(query({ q: "stelar" }));

      expect(response.fuzzyMode).toBe("levenshtein");
      expect(response.results.map((hit) => hit.ticker)).toEqual(["XLM"]);
      expect(response.results[0]).toMatchObject({
        match: "levenshtein",
        relevance: 0.375,
      });
      expect(window.setParameters).toHaveBeenCalledWith({
        window: "s%",
        contains: "%stelar%",
      });
    });

    it("returns an empty page when nothing is close enough", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const window = makeQueryBuilder({
        many: [asset({ id: "btc", ticker: "BTC", name: "Bitcoin" })],
      });
      const service = await buildService(
        makeRepository({
          queue: [structured, window],
          extensions: "unavailable",
        }),
      );

      const response = await service.search(query({ q: "wrapped sol" }));

      expect(response).toEqual({
        query: "wrapped sol",
        normalizedQuery: "wrapped sol",
        fuzzyMode: "levenshtein",
        total: 0,
        results: [],
      });
    });

    it("degrades to the in-process ranking if similarity() disappears at query time", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        throwOnRaw: Object.assign(
          new Error("function similarity(text, text) does not exist"),
          { code: "42883" },
        ),
      });
      const window = makeQueryBuilder({
        many: [asset({ id: "xlm", ticker: "XLM", name: "Stellar Lumens" })],
      });
      const service = await buildService(
        makeRepository({ queue: [structured, fuzzy, window] }),
      );

      const response = await service.search(query({ q: "stelar" }));

      expect(response.fuzzyMode).toBe("levenshtein");
      expect(response.results.map((hit) => hit.ticker)).toEqual(["XLM"]);
    });

    it("rethrows unrelated database errors", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        throwOnRaw: Object.assign(new Error("connection terminated"), {
          code: "08006",
        }),
      });
      const service = await buildService(
        makeRepository({ queue: [structured, fuzzy] }),
      );

      await expect(service.search(query({ q: "stelar" }))).rejects.toThrow(
        "connection terminated",
      );
    });
  });

  describe("merging stages", () => {
    it("keeps the higher-relevance copy of an asset both stages found", async () => {
      const shared = asset({
        id: "ethl",
        ticker: "ETHL",
        name: "Ether liquid",
      });
      const structured = makeQueryBuilder({ many: [shared] });
      const fuzzy = makeQueryBuilder({
        rawAndEntities: {
          entities: [shared],
          raw: [{ relevance_score: "0.4", edit_distance: "2" }],
        },
      });
      const service = await buildService(
        makeRepository({ queue: [structured, fuzzy] }),
      );

      const response = await service.search(query({ limit: 10 }));

      expect(response.fuzzyMode).toBe("trigram");
      expect(response.total).toBe(1);
      expect(response.results[0]).toMatchObject({
        id: "ethl",
        match: "prefix",
        relevance: 0.9,
      });
    });
  });

  describe("input handling", () => {
    it("returns an empty response for a blank query without touching the database", async () => {
      const repository = makeRepository();
      const service = await buildService(repository);

      const response = await service.search(query({ q: "   " }));

      expect(response).toEqual({
        query: "   ",
        normalizedQuery: "",
        fuzzyMode: "none",
        total: 0,
        results: [],
      });
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      expect(repository.query).not.toHaveBeenCalled();
    });

    it("honours exactOnly by never running the tolerant stage", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const repository = makeRepository({ queue: [structured] });
      const service = await buildService(repository);

      const response = await service.search(query({ exactOnly: true }));

      expect(response).toMatchObject({
        fuzzyMode: "none",
        total: 0,
        results: [],
      });
      expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(repository.query).not.toHaveBeenCalled();
    });

    it("clamps the page size to the documented maximum and floor", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const fuzzy = makeQueryBuilder({
        rawAndEntities: { entities: [], raw: [] },
      });
      const service = await buildService(
        makeRepository({ queue: [structured, fuzzy] }),
      );

      await service.search(query({ limit: 500 }));
      expect(structured.take).toHaveBeenCalledWith(50);
      expect(fuzzy.take).toHaveBeenCalledWith(50);

      const zeroStructured = makeQueryBuilder({ many: [] });
      const second = await buildService(
        makeRepository({ queue: [zeroStructured] }),
      );
      await second.search(query({ limit: 0 }));

      expect(zeroStructured.take).toHaveBeenCalledWith(1);
    });

    it("returns the original query verbatim alongside the normalised one", async () => {
      const structured = makeQueryBuilder({ many: [] });
      const service = await buildService(
        makeRepository({ queue: [structured] }),
      );

      const response = await service.search(
        query({ q: "  ETH  ", exactOnly: true }),
      );

      expect(response.query).toBe("  ETH  ");
      expect(response.normalizedQuery).toBe("eth");
    });
  });
});
