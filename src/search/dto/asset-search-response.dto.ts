/**
 * Response contract for `GET /search/assets`.
 *
 * `relevance` is normalised to `0..1` so callers can rank or threshold results
 * without knowing which engine produced them, and `match` records the strategy
 * that found the row so a client can explain a "did you mean" suggestion.
 */
export type AssetSearchMatch =
  | "exact"
  | "prefix"
  | "contains"
  | "trigram"
  | "levenshtein";

/** Which tolerant stage actually ran for this response. */
export type AssetSearchFuzzyMode = "trigram" | "levenshtein" | "none";

export interface AssetSearchHit {
  id: string;
  ticker: string;
  name: string;
  chain: string;
  type: string;
  portfolioId: string;
  /** `0..1`; `1` is an exact ticker match. */
  relevance: number;
  match: AssetSearchMatch;
}

export interface AssetSearchResponse {
  /** The query exactly as the caller sent it. */
  query: string;
  /** Case-folded, whitespace-collapsed query actually searched for. */
  normalizedQuery: string;
  /** `trigram` (pg_trgm), `levenshtein` (in-process fallback) or `none`. */
  fuzzyMode: AssetSearchFuzzyMode;
  total: number;
  results: AssetSearchHit[];
}
