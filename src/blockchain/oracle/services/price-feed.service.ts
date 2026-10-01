import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { JsonRpcProvider, Contract } from "ethers";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  PriceRecord,
  SupportedChain,
  PriceSource,
} from "../entities/price-record.entity";
import { PriceResponseDto } from "../dto/price-feed.dto";

/** Chainlink AggregatorV3Interface — only latestRoundData needed */
const CHAINLINK_ABI = [
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() external view returns (uint8)",
];

/** Band Protocol StdReference */
const BAND_ABI = [
  "function getReferenceData(string base, string quote) external view returns (uint256 rate, uint256 lastUpdatedBase, uint256 lastUpdatedQuote)",
];

/** Uniswap V3 Pool — for TWAP via slot0 + observe */
const UNISWAP_V3_POOL_ABI = [
  "function observe(uint32[] secondsAgos) external view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

/** DEVIATION_THRESHOLD for alerting (5%) */
const DEVIATION_THRESHOLD_PERCENT = 5;

/** Well-known contract addresses per chain */
const CHAIN_CONTRACTS: Record<
  SupportedChain,
  {
    rpcEnvKey: string;
    chainId: number;
    chainlink: Record<string, string>;
    band?: string;
    uniswapV3Pools?: Record<string, string>;
  }
> = {
  [SupportedChain.ETHEREUM]: {
    rpcEnvKey: "ETH_RPC_URL",
    chainId: 1,
    chainlink: {
      ETH: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
      BTC: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
      LINK: "0x2c1d072e956AFFC0D435Cb7AC308d97e0D8adf3B",
    },
    band: "0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
    uniswapV3Pools: {
      ETH: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // ETH/USDC 0.05%
    },
  },
  [SupportedChain.BSC]: {
    rpcEnvKey: "BSC_RPC_URL",
    chainId: 56,
    chainlink: {
      BNB: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
      ETH: "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e",
      BTC: "0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf",
    },
    band: "0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
  },
  [SupportedChain.POLYGON]: {
    rpcEnvKey: "POLY_RPC_URL",
    chainId: 137,
    chainlink: {
      ETH: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
      BTC: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
      MATIC: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0",
    },
    band: "0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
  },
  [SupportedChain.ARBITRUM]: {
    rpcEnvKey: "ARB_RPC_URL",
    chainId: 42161,
    chainlink: {
      ETH: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
      BTC: "0x6ce185960375d0D8B66bEBDAf4c8e1b0ed0A4728",
    },
  },
  [SupportedChain.OPTIMISM]: {
    rpcEnvKey: "OPT_RPC_URL",
    chainId: 10,
    chainlink: {
      ETH: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
      BTC: "0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593",
    },
  },
  [SupportedChain.AVALANCHE]: {
    rpcEnvKey: "AVAX_RPC_URL",
    chainId: 43114,
    chainlink: {
      AVAX: "0x0A77230d17318075983913bC2145DB16C7366156",
      ETH: "0x976B3D034E162d8bD72D6b9C989d545b839003b0",
      BTC: "0x2779D32d5166BAaa2B2b658333bA7e6Ec0C65743",
    },
  },
};

/** 30-minute TWAP window */
const TWAP_SECONDS = 1800;

/**
 * Freshness window for an oracle feed. A feed that has not published within
 * this window is treated as stale and excluded from the median: a price that
 * stopped moving is worse than no price, because it still looks like one.
 */
export const DEFAULT_MAX_FEED_AGE_SECONDS = 60;

/** A feed more than this far from the median is treated as an outlier. */
export const OUTLIER_DEVIATION_PERCENT = DEVIATION_THRESHOLD_PERCENT;

/** A single oracle reading plus the moment it was published. */
export interface OracleQuote {
  price: number;
  /** Epoch ms the feed last updated; null when the source reports no timestamp. */
  updatedAt: number | null;
}

/** Why a feed was left out of the median. */
export type OracleRejectionReason = "unavailable" | "stale" | "outlier";

/** Per-feed outcome of the medianizer. */
export interface OracleQuoteResult {
  source: PriceSource;
  price: number | null;
  updatedAt: Date | null;
  ageSeconds: number | null;
  accepted: boolean;
  deviationPercent: number | null;
  reason?: OracleRejectionReason;
}

/** How much to trust a median, based on how many feeds survived. */
export type OracleConfidence = "high" | "medium" | "low" | "none";

/** Result of aggregating every configured oracle for one asset/chain. */
export interface OracleAggregation {
  price: number;
  acceptedSources: PriceSource[];
  quotes: OracleQuoteResult[];
  stale: boolean;
  usedFallbackPrice: boolean;
  maxDeviationPercent: number;
  confidence: OracleConfidence;
}

@Injectable()
export class PriceFeedService {
  private readonly logger = new Logger(PriceFeedService.name);
  private readonly providers = new Map<SupportedChain, JsonRpcProvider>();
  private readonly maxFeedAgeSeconds: number;

  constructor(
    @InjectRepository(PriceRecord)
    private readonly priceRecordRepository: Repository<PriceRecord>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.initProviders();
    this.maxFeedAgeSeconds = resolveMaxFeedAgeSeconds(
      this.configService.get<string>("PRICE_FEED_MAX_STALENESS_SECONDS"),
    );
  }

  private initProviders(): void {
    for (const [chain, cfg] of Object.entries(CHAIN_CONTRACTS)) {
      const url = this.configService.get<string>(cfg.rpcEnvKey);
      if (url) {
        this.providers.set(chain as SupportedChain, new JsonRpcProvider(url));
      }
    }
  }

  /**
   * Fetch the current price for an asset on a chain, aggregate from all
   * available sources, compute median, persist, and alert on deviation.
   */
  async getCurrentPrice(
    asset: string,
    chain: SupportedChain,
  ): Promise<PriceResponseDto> {
    const quotes = await this.fetchAllSources(asset, chain);
    const aggregation = this.aggregateOracleQuotes(quotes);

    let sourcePrices: Partial<Record<PriceSource, number>> = {};
    for (const quote of aggregation.quotes) {
      if (quote.accepted && quote.price !== null) {
        sourcePrices[quote.source] = quote.price;
      }
    }

    let usedFallbackPrice = false;
    let price = aggregation.price;

    // Every feed was stale (or none exists): reuse the last price we know was
    // valid rather than pricing a position off a dead feed.
    if (aggregation.acceptedSources.length === 0) {
      const lastKnown = await this.findLastKnownPrice(asset, chain);

      if (!lastKnown) {
        throw new Error(
          `No price sources available for ${asset} on ${chain} and no last known price to fall back to. Configure RPC URLs.`,
        );
      }

      price = Number(lastKnown.price);
      usedFallbackPrice = true;
      sourcePrices = { ...(lastKnown.sourcePrices ?? {}) };
      // Recorded on the aggregation so the alert reports the fallback it just
      // made rather than the fresh price it did not have.
      aggregation.usedFallbackPrice = true;
      this.emitStaleFallbackAlert(asset, chain, aggregation, price);
    } else if (aggregation.stale) {
      this.emitStaleFallbackAlert(asset, chain, aggregation, price);
    }

    const outliers = aggregation.quotes
      .filter((q) => q.reason === "outlier")
      .map((q) => q.source);
    const staleSources = aggregation.quotes
      .filter((q) => q.reason === "stale")
      .map((q) => q.source);

    const deviationAlert =
      outliers.length > 0 || aggregation.maxDeviationPercent > DEVIATION_THRESHOLD_PERCENT;

    if (deviationAlert) {
      this.eventEmitter.emit("price.deviation", {
        asset,
        chain,
        prices: sourcePrices,
        maxDeviationPercent: aggregation.maxDeviationPercent,
        outliers,
      });
      this.logger.warn(
        `Price deviation alert: ${asset}/${chain} — max deviation ${aggregation.maxDeviationPercent.toFixed(2)}%`,
      );
    }

    const record = this.priceRecordRepository.create({
      asset: asset.toUpperCase(),
      chain,
      price,
      sourcePrices: sourcePrices as Record<PriceSource, number>,
      deviationAlert,
      maxDeviationPercent: aggregation.maxDeviationPercent,
    });

    const saved = await this.priceRecordRepository.save(record);

    return {
      ...this.toResponseDto(saved),
      stale: aggregation.stale,
      usedFallbackPrice,
      staleSources,
      outliers,
      acceptedSources: aggregation.acceptedSources,
    };
  }

  /**
   * Aggregate every configured oracle for an asset/chain without persisting.
   * Exposes which feeds were used, which were stale and which were dropped as
   * outliers, so a caller can see how much to trust the median.
   */
  async getOracleAggregation(
    asset: string,
    chain: SupportedChain,
    maxAgeSeconds?: number,
  ): Promise<OracleAggregation & { maxAgeSeconds: number }> {
    const quotes = await this.fetchAllSources(asset, chain);
    const aggregation = this.aggregateOracleQuotes(quotes, maxAgeSeconds);

    if (aggregation.acceptedSources.length === 0) {
      const lastKnown = await this.findLastKnownPrice(asset, chain);
      if (lastKnown) {
        aggregation.price = Number(lastKnown.price);
        aggregation.usedFallbackPrice = true;
        aggregation.confidence = "none";
        this.emitStaleFallbackAlert(
          asset,
          chain,
          aggregation,
          aggregation.price,
        );
      }
    }

    return {
      ...aggregation,
      maxAgeSeconds: maxAgeSeconds ?? this.maxFeedAgeSeconds,
    };
  }

  /**
   * Medianizer: drop feeds that are stale or unusable, then drop statistical
   * outliers, then take the median of what is left.
   *
   * Outliers are measured against the median rather than against each other
   * so that one manipulated feed cannot drag the reference value with it. The
   * median is only ever taken over a set of independent feeds, which is the
   * whole point — a single oracle is a single point of failure.
   */
  aggregateOracleQuotes(
    quotes: Partial<Record<PriceSource, OracleQuote>>,
    maxAgeSeconds: number = this.maxFeedAgeSeconds,
    now: number = Date.now(),
  ): OracleAggregation {
    const results: OracleQuoteResult[] = [];
    const fresh: {
      source: PriceSource;
      price: number;
      updatedAt: number | null;
      ageSeconds: number | null;
    }[] = [];
    let sawStale = false;

    for (const source of Object.values(PriceSource)) {
      const quote = quotes[source];

      if (!quote || !isUsablePrice(quote.price)) {
        results.push({
          source,
          price: null,
          updatedAt: null,
          ageSeconds: null,
          accepted: false,
          deviationPercent: null,
          reason: "unavailable",
        });
        continue;
      }

      const updatedAt = quote.updatedAt ?? null;
      const ageSeconds = updatedAt === null ? null : Math.max(0, (now - updatedAt) / 1000);

      if (ageSeconds !== null && ageSeconds > maxAgeSeconds) {
        sawStale = true;
        results.push({
          source,
          price: quote.price,
          updatedAt: new Date(updatedAt),
          ageSeconds,
          accepted: false,
          deviationPercent: null,
          reason: "stale",
        });
        continue;
      }

      fresh.push({
        source,
        price: quote.price,
        updatedAt,
        ageSeconds,
      });
    }

    if (fresh.length === 0) {
      return {
        price: 0,
        acceptedSources: [],
        quotes: results,
        stale: sawStale,
        usedFallbackPrice: false,
        maxDeviationPercent: 0,
        confidence: "none",
      };
    }

    const median = medianOf(fresh.map((f) => f.price));
    const accepted: typeof fresh = [];

    for (const candidate of fresh) {
      const deviationPercent =
        median > 0 ? (Math.abs(candidate.price - median) / median) * 100 : 0;

      if (deviationPercent > OUTLIER_DEVIATION_PERCENT) {
        results.push({
          source: candidate.source,
          price: candidate.price,
          updatedAt:
            candidate.updatedAt === null ? null : new Date(candidate.updatedAt),
          ageSeconds: candidate.ageSeconds,
          accepted: false,
          deviationPercent,
          reason: "outlier",
        });
        continue;
      }

      accepted.push(candidate);
      results.push({
        source: candidate.source,
        price: candidate.price,
        updatedAt:
          candidate.updatedAt === null ? null : new Date(candidate.updatedAt),
        ageSeconds: candidate.ageSeconds,
        accepted: true,
        deviationPercent,
      });
    }

    // A lone outlier cannot be discarded: rejecting every feed would leave the
    // medianizer with nothing to return but a guess, so the full set stands.
    const contributors = accepted.length > 0 ? accepted : fresh;
    const keptPrices = contributors.map((c) => c.price);

    return {
      price: medianOf(keptPrices),
      acceptedSources: contributors.map((c) => c.source),
      quotes: sortBySource(results),
      stale: sawStale,
      usedFallbackPrice: false,
      maxDeviationPercent: maxDeviationPercent(keptPrices),
      confidence: confidenceFor(contributors.length),
    };
  }

  /**
   * Return stored historical prices for an asset/chain pair.
   */
  async getHistoricalPrices(
    asset: string,
    chain: SupportedChain,
    limit = 100,
  ): Promise<PriceResponseDto[]> {
    const records = await this.priceRecordRepository.find({
      where: { asset: asset.toUpperCase(), chain },
      order: { createdAt: "DESC" },
      take: limit,
    });
    return records.map((r) => this.toResponseDto(r));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchAllSources(
    asset: string,
    chain: SupportedChain,
  ): Promise<Partial<Record<PriceSource, OracleQuote>>> {
    const provider = this.providers.get(chain);
    const cfg = CHAIN_CONTRACTS[chain];
    const prices: Partial<Record<PriceSource, OracleQuote>> = {};

    if (!provider) {
      return prices;
    }

    const ticker = asset.toUpperCase();

    await Promise.allSettled([
      // Chainlink
      (async () => {
        const feedAddress = cfg.chainlink?.[ticker];
        if (!feedAddress) return;
        const feed = new Contract(feedAddress, CHAINLINK_ABI, provider);
        const [roundData, decimals] = await Promise.all([
          feed.latestRoundData(),
          feed.decimals(),
        ]);
        prices[PriceSource.CHAINLINK] = {
          price: Number(roundData.answer) / 10 ** Number(decimals),
          // 0 means "round never completed", which is not the same as fresh.
          updatedAt: toEpochMs(roundData.updatedAt),
        };
      })(),

      // Band Protocol
      (async () => {
        if (!cfg.band) return;
        const ref = new Contract(cfg.band, BAND_ABI, provider);
        const data = await ref.getReferenceData(ticker, "USD");
        // Band returns rate with 18 decimals
        prices[PriceSource.BAND] = {
          price: Number(data.rate) / 1e18,
          updatedAt: toEpochMs(
            data.lastUpdatedBase > data.lastUpdatedQuote
              ? data.lastUpdatedBase
              : data.lastUpdatedQuote,
          ),
        };
      })(),

      // Uniswap V3 TWAP
      (async () => {
        const poolAddress = cfg.uniswapV3Pools?.[ticker];
        if (!poolAddress) return;
        const pool = new Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
        const [token0, observations] = await Promise.all([
          pool.token0(),
          pool.observe([TWAP_SECONDS, 0]),
        ]);
        const [tickCumulativeOld, tickCumulativeNew] =
          observations.tickCumulatives;
        const avgTick =
          (Number(tickCumulativeNew) - Number(tickCumulativeOld)) /
          TWAP_SECONDS;
        // tick → price: price = 1.0001^tick
        // token0 is USDC on ETH/USDC pool, so price is inverted
        const rawPrice = Math.pow(1.0001, avgTick);
        // USDC has 6 decimals, WETH has 18 — adjust
        const adjustedPrice = (1 / rawPrice) * 1e12;
        prices[PriceSource.UNISWAP_TWAP] = {
          price: adjustedPrice,
          // Computed from the chain at request time, so it cannot be stale.
          updatedAt: Date.now(),
        };
        void token0; // used for context, suppress lint
      })(),
    ]);

    return prices;
  }

  /** Most recent persisted price for an asset/chain, i.e. the last known good. */
  private async findLastKnownPrice(
    asset: string,
    chain: SupportedChain,
  ): Promise<PriceRecord | null> {
    return this.priceRecordRepository.findOne({
      where: { asset: asset.toUpperCase(), chain },
      order: { createdAt: "DESC" },
    });
  }

  private emitStaleFallbackAlert(
    asset: string,
    chain: SupportedChain,
    aggregation: OracleAggregation,
    price: number,
  ): void {
    this.eventEmitter.emit("price.stale", {
      asset,
      chain,
      price,
      confidence: aggregation.confidence,
      staleSources: aggregation.quotes
        .filter((q) => q.reason === "stale")
        .map((q) => q.source),
      usedFallbackPrice: aggregation.usedFallbackPrice,
      maxDeviationPercent: aggregation.maxDeviationPercent,
    });

    this.logger.warn(
      `Stale price feeds for ${asset}/${chain} — ` +
        `${aggregation.quotes.filter((q) => q.reason === "stale").length} feed(s) past the ` +
        `${this.maxFeedAgeSeconds}s freshness window` +
        (aggregation.usedFallbackPrice
          ? "; falling back to the last known valid price"
          : ""),
    );
  }

  /**
   * Compute median and max pairwise deviation from a set of prices.
   */
  aggregatePrices(prices: Partial<Record<PriceSource, number>>): {
    median: number;
    maxDeviationPercent: number;
  } {
    const values = Object.values(prices).filter(
      (v): v is number => typeof v === "number" && isFinite(v) && v > 0,
    );

    if (values.length === 0) {
      return { median: 0, maxDeviationPercent: 0 };
    }

    return {
      median: medianOf(values),
      maxDeviationPercent: maxDeviationPercent(values),
    };
  }

  private toResponseDto(record: PriceRecord): PriceResponseDto {
    return {
      asset: record.asset,
      chain: record.chain,
      price: Number(record.price),
      sourcePrices: record.sourcePrices,
      deviationAlert: record.deviationAlert,
      maxDeviationPercent: Number(record.maxDeviationPercent),
      stale: false,
      usedFallbackPrice: false,
      staleSources: [],
      outliers: [],
      acceptedSources: Object.keys(record.sourcePrices ?? {}) as PriceSource[],
      timestamp: record.createdAt,
    };
  }
}

/** Median of a non-empty list of prices. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Largest pairwise deviation, as a percentage of the pair's midpoint. */
function maxDeviationPercent(values: number[]): number {
  let max = 0;

  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const avg = (values[i] + values[j]) / 2;
      const dev = avg > 0 ? (Math.abs(values[i] - values[j]) / avg) * 100 : 0;
      if (dev > max) max = dev;
    }
  }

  return max;
}

function isUsablePrice(price: unknown): price is number {
  return typeof price === "number" && isFinite(price) && price > 0;
}

/** Chain timestamps are in seconds; 0 means "never", which is not fresh. */
function toEpochMs(seconds: unknown): number | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;

  return value * 1000;
}

function confidenceFor(feedCount: number): OracleConfidence {
  if (feedCount >= 3) return "high";
  if (feedCount === 2) return "medium";
  if (feedCount === 1) return "low";
  return "none";
}

function sortBySource(quotes: OracleQuoteResult[]): OracleQuoteResult[] {
  const order = Object.values(PriceSource);
  return [...quotes].sort(
    (a, b) => order.indexOf(a.source) - order.indexOf(b.source),
  );
}

function resolveMaxFeedAgeSeconds(configured?: string): number {
  const parsed = Number.parseInt(
    configured ?? process.env.PRICE_FEED_MAX_STALENESS_SECONDS ?? "",
    10,
  );

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return DEFAULT_MAX_FEED_AGE_SECONDS;
}
