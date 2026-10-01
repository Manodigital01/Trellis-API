import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  DEFAULT_MAX_FEED_AGE_SECONDS,
  PriceFeedService,
} from "./price-feed.service";
import {
  PriceRecord,
  SupportedChain,
  PriceSource,
} from "../entities/price-record.entity";

const mockRepo = {
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
};

const mockConfig = { get: jest.fn().mockReturnValue(undefined) };
const mockEmitter = { emit: jest.fn() };

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

/** A quote published `secondsAgo` seconds before NOW. */
function quote(price: number, secondsAgo = 5) {
  return { price, updatedAt: NOW - secondsAgo * 1000 };
}

describe("PriceFeedService", () => {
  let service: PriceFeedService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceFeedService,
        { provide: getRepositoryToken(PriceRecord), useValue: mockRepo },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get<PriceFeedService>(PriceFeedService);
    jest.clearAllMocks();
    mockRepo.findOne.mockResolvedValue(null);
  });

  describe("aggregatePrices", () => {
    it("returns median of a single price with zero deviation", () => {
      const { median, maxDeviationPercent } = service.aggregatePrices({
        [PriceSource.CHAINLINK]: 2000,
      });
      expect(median).toBe(2000);
      expect(maxDeviationPercent).toBe(0);
    });

    it("returns middle value as median for odd count", () => {
      const { median } = service.aggregatePrices({
        [PriceSource.CHAINLINK]: 100,
        [PriceSource.BAND]: 200,
        [PriceSource.UNISWAP_TWAP]: 300,
      });
      expect(median).toBe(200);
    });

    it("returns average of two middle values for even count", () => {
      const { median } = service.aggregatePrices({
        [PriceSource.CHAINLINK]: 100,
        [PriceSource.BAND]: 200,
      });
      expect(median).toBe(150);
    });

    it("computes max pairwise deviation correctly", () => {
      const { maxDeviationPercent } = service.aggregatePrices({
        [PriceSource.CHAINLINK]: 100,
        [PriceSource.BAND]: 110,
      });
      // avg=105, |100-110|/105*100 ≈ 9.52%
      expect(maxDeviationPercent).toBeCloseTo(9.52, 1);
    });

    it("returns zero deviation when all prices are identical", () => {
      const { maxDeviationPercent } = service.aggregatePrices({
        [PriceSource.CHAINLINK]: 2000,
        [PriceSource.BAND]: 2000,
        [PriceSource.UNISWAP_TWAP]: 2000,
      });
      expect(maxDeviationPercent).toBe(0);
    });

    it("ignores non-positive values", () => {
      const { median } = service.aggregatePrices({
        [PriceSource.CHAINLINK]: -10,
        [PriceSource.BAND]: 0,
        [PriceSource.UNISWAP_TWAP]: 500,
      });
      expect(median).toBe(500);
    });

    it("returns zeros when prices object is empty", () => {
      const { median, maxDeviationPercent } = service.aggregatePrices({});
      expect(median).toBe(0);
      expect(maxDeviationPercent).toBe(0);
    });
  });

  describe("aggregateOracleQuotes (medianizer)", () => {
    it("takes the median across three fresh feeds with high confidence", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000),
          [PriceSource.BAND]: quote(2010),
          [PriceSource.UNISWAP_TWAP]: quote(2005),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(result.price).toBe(2005);
      expect(result.acceptedSources).toHaveLength(3);
      expect(result.confidence).toBe("high");
      expect(result.stale).toBe(false);
      expect(result.usedFallbackPrice).toBe(false);
    });

    it("discards a feed older than the freshness window", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000, 61),
          [PriceSource.BAND]: quote(2010, 5),
          [PriceSource.UNISWAP_TWAP]: quote(2005, 5),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      const chainlink = result.quotes.find(
        (q) => q.source === PriceSource.CHAINLINK,
      );

      expect(chainlink.accepted).toBe(false);
      expect(chainlink.reason).toBe("stale");
      expect(chainlink.ageSeconds).toBe(61);
      expect(result.price).toBe(2005);
      expect(result.stale).toBe(true);
    });

    it("keeps a feed inside the freshness window", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000, 60),
          [PriceSource.BAND]: quote(2010, 60),
          [PriceSource.UNISWAP_TWAP]: quote(2005, 60),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(result.acceptedSources).toHaveLength(3);
      expect(result.stale).toBe(false);
    });

    it("honours a caller-supplied freshness window", () => {
      const staleByDefault = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000, 120),
          [PriceSource.BAND]: quote(2010, 5),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );
      expect(staleByDefault.acceptedSources).toEqual([PriceSource.BAND]);
      expect(staleByDefault.stale).toBe(true);

      const widerWindow = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000, 120),
          [PriceSource.BAND]: quote(2010, 5),
        },
        600,
        NOW,
      );
      expect(widerWindow.acceptedSources).toEqual([
        PriceSource.CHAINLINK,
        PriceSource.BAND,
      ]);
      expect(widerWindow.stale).toBe(false);
    });

    it("treats a feed with no timestamp as fresh rather than stale", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: { price: 2000, updatedAt: null },
          [PriceSource.BAND]: quote(2010),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      const chainlink = result.quotes.find(
        (q) => q.source === PriceSource.CHAINLINK,
      );

      expect(chainlink.accepted).toBe(true);
      expect(chainlink.ageSeconds).toBeNull();
    });

    it("discards a statistical outlier more than 5% from the median", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000),
          [PriceSource.BAND]: quote(2010),
          [PriceSource.UNISWAP_TWAP]: quote(3000),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      const outlier = result.quotes.find(
        (q) => q.source === PriceSource.UNISWAP_TWAP,
      );

      expect(outlier.accepted).toBe(false);
      expect(outlier.reason).toBe("outlier");
      expect(result.acceptedSources).toEqual([
        PriceSource.CHAINLINK,
        PriceSource.BAND,
      ]);
      expect(result.price).toBe(2005);
    });

    it("is not moved by a single manipulated feed", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000),
          [PriceSource.BAND]: quote(2001),
          [PriceSource.UNISWAP_TWAP]: quote(4000),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(result.price).toBe(2000.5);
      expect(result.acceptedSources).not.toContain(PriceSource.UNISWAP_TWAP);
    });

    it("never discards every feed it is given", () => {
      const result = service.aggregateOracleQuotes(
        { [PriceSource.CHAINLINK]: quote(1000) },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(result.price).toBe(1000);
      expect(result.acceptedSources).toEqual([PriceSource.CHAINLINK]);
      expect(result.confidence).toBe("low");
    });

    it("marks unusable prices as unavailable", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(0),
          [PriceSource.BAND]: { price: Number.NaN, updatedAt: NOW },
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(
        result.quotes.every((q) => q.reason === "unavailable"),
      ).toBe(true);
      expect(result.price).toBe(0);
      expect(result.confidence).toBe("none");
    });

    it("returns nothing usable when every feed is stale", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000, 600),
          [PriceSource.BAND]: quote(2010, 900),
          [PriceSource.UNISWAP_TWAP]: quote(2005, 3600),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(result.price).toBe(0);
      expect(result.acceptedSources).toEqual([]);
      expect(result.confidence).toBe("none");
      expect(result.stale).toBe(true);
    });

    it("reports medium confidence for two surviving feeds", () => {
      const result = service.aggregateOracleQuotes(
        {
          [PriceSource.CHAINLINK]: quote(2000),
          [PriceSource.BAND]: quote(2010),
        },
        DEFAULT_MAX_FEED_AGE_SECONDS,
        NOW,
      );

      expect(result.confidence).toBe("medium");
      expect(result.price).toBe(2005);
    });
  });

  describe("getCurrentPrice", () => {
    it("throws when no RPC provider is configured for the chain", async () => {
      await expect(
        service.getCurrentPrice("ETH", SupportedChain.ETHEREUM),
      ).rejects.toThrow(/No price sources available/);
    });

    it("persists a PriceRecord and returns a PriceResponseDto", async () => {
      const fakeQuotes = {
        [PriceSource.CHAINLINK]: { price: 2000, updatedAt: null },
        [PriceSource.BAND]: { price: 2010, updatedAt: null },
      };
      jest
        .spyOn(service as any, "fetchAllSources")
        .mockResolvedValue(fakeQuotes);

      const fakeRecord: Partial<PriceRecord> = {
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 2005,
        sourcePrices: fakeQuotes as unknown as Record<PriceSource, number>,
        deviationAlert: false,
        maxDeviationPercent: 0.5,
        createdAt: new Date("2026-01-01"),
      };
      mockRepo.create.mockReturnValue(fakeRecord);
      mockRepo.save.mockResolvedValue(fakeRecord);

      const result = await service.getCurrentPrice(
        "ETH",
        SupportedChain.ETHEREUM,
      );

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          asset: "ETH",
          chain: SupportedChain.ETHEREUM,
          price: 2005,
        }),
      );
      expect(mockRepo.save).toHaveBeenCalledWith(fakeRecord);
      expect(result.asset).toBe("ETH");
      expect(result.chain).toBe(SupportedChain.ETHEREUM);
      expect(result.acceptedSources).toEqual([
        PriceSource.CHAINLINK,
        PriceSource.BAND,
      ]);
    });

    it("emits price.deviation event when deviation exceeds 5%", async () => {
      const fakeQuotes = {
        [PriceSource.CHAINLINK]: { price: 100, updatedAt: null },
        [PriceSource.BAND]: { price: 110, updatedAt: null },
      };
      jest
        .spyOn(service as any, "fetchAllSources")
        .mockResolvedValue(fakeQuotes);

      const fakeRecord: Partial<PriceRecord> = {
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 105,
        sourcePrices: fakeQuotes as unknown as Record<PriceSource, number>,
        deviationAlert: true,
        maxDeviationPercent: 9.52,
        createdAt: new Date(),
      };
      mockRepo.create.mockReturnValue(fakeRecord);
      mockRepo.save.mockResolvedValue(fakeRecord);

      await service.getCurrentPrice("ETH", SupportedChain.ETHEREUM);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "price.deviation",
        expect.objectContaining({
          asset: "ETH",
          chain: SupportedChain.ETHEREUM,
        }),
      );
    });

    it("does NOT emit deviation event when deviation is below 5%", async () => {
      const fakeQuotes = {
        [PriceSource.CHAINLINK]: { price: 2000, updatedAt: null },
        [PriceSource.BAND]: { price: 2001, updatedAt: null },
      };
      jest
        .spyOn(service as any, "fetchAllSources")
        .mockResolvedValue(fakeQuotes);

      const fakeRecord: Partial<PriceRecord> = {
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 2000.5,
        sourcePrices: fakeQuotes as unknown as Record<PriceSource, number>,
        deviationAlert: false,
        maxDeviationPercent: 0.05,
        createdAt: new Date(),
      };
      mockRepo.create.mockReturnValue(fakeRecord);
      mockRepo.save.mockResolvedValue(fakeRecord);

      await service.getCurrentPrice("ETH", SupportedChain.ETHEREUM);
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it("falls back to the last known valid price when every feed is stale", async () => {
      jest.spyOn(service as any, "fetchAllSources").mockResolvedValue({
        [PriceSource.CHAINLINK]: {
          price: 2000,
          updatedAt: Date.now() - 10 * 60 * 1000,
        },
        [PriceSource.BAND]: {
          price: 2010,
          updatedAt: Date.now() - 10 * 60 * 1000,
        },
      });

      mockRepo.findOne.mockResolvedValue({
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 1900,
        sourcePrices: { [PriceSource.CHAINLINK]: 1900 },
        createdAt: new Date("2025-12-31T00:00:00.000Z"),
      });

      const savedRecord = {
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 1900,
        sourcePrices: { [PriceSource.CHAINLINK]: 1900 },
        deviationAlert: false,
        maxDeviationPercent: 0,
        createdAt: new Date(),
      };
      mockRepo.create.mockReturnValue(savedRecord);
      mockRepo.save.mockResolvedValue(savedRecord);

      const result = await service.getCurrentPrice(
        "ETH",
        SupportedChain.ETHEREUM,
      );

      expect(result.price).toBe(1900);
      expect(result.usedFallbackPrice).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleSources).toEqual([
        PriceSource.CHAINLINK,
        PriceSource.BAND,
      ]);
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "price.stale",
        expect.objectContaining({
          asset: "ETH",
          usedFallbackPrice: true,
        }),
      );
    });

    it("throws when nothing is fresh and there is no last known price", async () => {
      jest.spyOn(service as any, "fetchAllSources").mockResolvedValue({
        [PriceSource.CHAINLINK]: {
          price: 2000,
          updatedAt: Date.now() - 10 * 60 * 1000,
        },
      });
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getCurrentPrice("ETH", SupportedChain.ETHEREUM),
      ).rejects.toThrow(/No price sources available/);
    });

    it("flags outliers in the response", async () => {
      jest.spyOn(service as any, "fetchAllSources").mockResolvedValue({
        [PriceSource.CHAINLINK]: { price: 2000, updatedAt: null },
        [PriceSource.BAND]: { price: 2010, updatedAt: null },
        [PriceSource.UNISWAP_TWAP]: { price: 5000, updatedAt: null },
      });

      const savedRecord = {
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 2005,
        sourcePrices: {
          [PriceSource.CHAINLINK]: 2000,
          [PriceSource.BAND]: 2010,
        } as Record<PriceSource, number>,
        deviationAlert: true,
        maxDeviationPercent: 0.5,
        createdAt: new Date(),
      };
      mockRepo.create.mockReturnValue(savedRecord);
      mockRepo.save.mockResolvedValue(savedRecord);

      const result = await service.getCurrentPrice(
        "ETH",
        SupportedChain.ETHEREUM,
      );

      expect(result.outliers).toEqual([PriceSource.UNISWAP_TWAP]);
      expect(result.acceptedSources).toEqual([
        PriceSource.CHAINLINK,
        PriceSource.BAND,
      ]);
    });
  });

  describe("getOracleAggregation", () => {
    it("returns a per-feed breakdown without persisting anything", async () => {
      jest.spyOn(service as any, "fetchAllSources").mockResolvedValue({
        [PriceSource.CHAINLINK]: {
          price: 2000,
          updatedAt: Date.now() - 5 * 1000,
        },
        [PriceSource.BAND]: { price: 2010, updatedAt: null },
        [PriceSource.UNISWAP_TWAP]: { price: 5000, updatedAt: null },
      });

      const result = await service.getOracleAggregation(
        "ETH",
        SupportedChain.ETHEREUM,
      );

      expect(result.price).toBe(2005);
      expect(result.maxAgeSeconds).toBe(DEFAULT_MAX_FEED_AGE_SECONDS);
      expect(result.confidence).toBe("medium");
      expect(result.quotes).toHaveLength(3);
      expect(result.quotes.find((q) => q.source === PriceSource.UNISWAP_TWAP)
        .reason).toBe("outlier");
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it("reuses the last known price when a single oracle is down", async () => {
      jest.spyOn(service as any, "fetchAllSources").mockResolvedValue({
        [PriceSource.CHAINLINK]: {
          price: 2000,
          updatedAt: Date.now() - 30 * 60 * 1000,
        },
        [PriceSource.BAND]: {
          price: 2010,
          updatedAt: Date.now() - 30 * 60 * 1000,
        },
      });
      mockRepo.findOne.mockResolvedValue({
        asset: "ETH",
        chain: SupportedChain.ETHEREUM,
        price: 1990,
        sourcePrices: { [PriceSource.CHAINLINK]: 1990 },
        createdAt: new Date(),
      });

      const result = await service.getOracleAggregation(
        "ETH",
        SupportedChain.ETHEREUM,
      );

      expect(result.price).toBe(1990);
      expect(result.usedFallbackPrice).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.confidence).toBe("none");
    });
  });

  describe("getHistoricalPrices", () => {
    it("queries repository with correct filters and returns mapped DTOs", async () => {
      const records: Partial<PriceRecord>[] = [
        {
          asset: "ETH",
          chain: SupportedChain.ETHEREUM,
          price: 2000,
          sourcePrices: {
            [PriceSource.CHAINLINK]: 2000,
          } as Record<PriceSource, number>,
          deviationAlert: false,
          maxDeviationPercent: 0,
          createdAt: new Date("2026-01-01"),
        },
      ];
      mockRepo.find.mockResolvedValue(records);

      const results = await service.getHistoricalPrices(
        "ETH",
        SupportedChain.ETHEREUM,
        50,
      );

      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { asset: "ETH", chain: SupportedChain.ETHEREUM },
          take: 50,
          order: { createdAt: "DESC" },
        }),
      );
      expect(results).toHaveLength(1);
      expect(results[0].asset).toBe("ETH");
      expect(results[0].price).toBe(2000);
    });

    it("defaults to 100 records when no limit is given", async () => {
      mockRepo.find.mockResolvedValue([]);
      await service.getHistoricalPrices("BTC", SupportedChain.BSC);
      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });
});
