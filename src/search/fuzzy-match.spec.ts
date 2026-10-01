import {
  DEFAULT_MAX_EDIT_DISTANCE,
  DEFAULT_MIN_SIMILARITY,
  combineFuzzyRelevance,
  escapeLikePattern,
  isTypoMatch,
  levenshtein,
  normalizeAssetQuery,
  scoreTypoMatch,
  trigramSimilarity,
} from "./fuzzy-match";

describe("fuzzy-match", () => {
  describe("normalizeAssetQuery", () => {
    it("case-folds, trims and collapses whitespace", () => {
      expect(normalizeAssetQuery("  Stellar   Lumens  ")).toBe(
        "stellar lumens",
      );
    });

    it("returns an empty string for missing input", () => {
      expect(normalizeAssetQuery(undefined)).toBe("");
      expect(normalizeAssetQuery(null)).toBe("");
      expect(normalizeAssetQuery("   ")).toBe("");
    });
  });

  describe("escapeLikePattern", () => {
    it("escapes LIKE metacharacters so a query cannot widen the pattern", () => {
      expect(escapeLikePattern("a%b")).toBe("a\\%b");
      expect(escapeLikePattern("a_b")).toBe("a\\_b");
      expect(escapeLikePattern("%")).toBe("\\%");
      expect(escapeLikePattern("plain")).toBe("plain");
    });
  });

  describe("levenshtein", () => {
    it("computes the classic edit distance", () => {
      expect(levenshtein("kitten", "sitting")).toBe(3);
      expect(levenshtein("eth", "etth")).toBe(1);
      expect(levenshtein("stellar", "stellar")).toBe(0);
    });

    it("handles empty strings in either position", () => {
      expect(levenshtein("", "abc")).toBe(3);
      expect(levenshtein("abc", "")).toBe(3);
      expect(levenshtein("", "")).toBe(0);
    });

    it("is symmetric", () => {
      expect(levenshtein("ethereum", "etherum")).toBe(
        levenshtein("etherum", "ethereum"),
      );
    });
  });

  describe("trigramSimilarity", () => {
    it("scores identical strings as 1", () => {
      expect(trigramSimilarity("stellar", "stellar")).toBe(1);
    });

    it("scores an unrelated pair as 0", () => {
      expect(trigramSimilarity("eth", "btc")).toBe(0);
    });

    it("scores a one character typo high enough to be useful", () => {
      // pg_trgm's Jaccard form: 6 shared trigrams out of a union of 9.
      expect(trigramSimilarity("stelar", "stellar")).toBeCloseTo(0.6667, 3);
    });

    it("returns 0 when either side is empty", () => {
      expect(trigramSimilarity("", "eth")).toBe(0);
      expect(trigramSimilarity("eth", "")).toBe(0);
    });
  });

  describe("scoreTypoMatch", () => {
    it("returns 1 for an exact match", () => {
      expect(scoreTypoMatch("eth", "ETH")).toBe(1);
    });

    it("matches the issue's examples: Stelar -> stellar, ETTH -> eth", () => {
      expect(isTypoMatch("Stelar", "Stellar")).toBe(true);
      expect(isTypoMatch("ETTH", "ETH")).toBe(true);
    });

    it("scores a trailing-character typo", () => {
      // Similarity carries these: the string is long enough to keep its shape.
      expect(scoreTypoMatch("ethereum", "ethereumx")).toBeGreaterThan(0);
      expect(isTypoMatch("tesla", "teslo")).toBe(true);
    });

    it("rejects unrelated assets", () => {
      expect(scoreTypoMatch("eth", "btc")).toBeNull();
      expect(isTypoMatch("stellar", "bitcoin")).toBe(false);
    });

    it("requires the first character to match before the edit-distance arm applies", () => {
      // Two substitutions on a 3-character ticker would otherwise look "close":
      // eth -> btc is only two edits, but a different asset.
      expect(scoreTypoMatch("eth", "btc")).toBeNull();
      expect(scoreTypoMatch("sol", "xlm")).toBeNull();

      // A transposition keeps the first character, so it is still a match.
      expect(scoreTypoMatch("eth", "eht")).toBeGreaterThan(0);
    });

    it("returns null for empty input instead of matching everything", () => {
      expect(scoreTypoMatch("", "eth")).toBeNull();
      expect(scoreTypoMatch("eth", "")).toBeNull();
    });

    it("honours caller thresholds", () => {
      expect(
        scoreTypoMatch("stelar", "stellar", {
          minSimilarity: 0.9,
          maxDistance: 0,
        }),
      ).toBeNull();

      expect(
        scoreTypoMatch("stelar", "stellar", {
          minSimilarity: 0.9,
          maxDistance: 1,
        }),
      ).toBeGreaterThan(0);
    });

    it("exposes the documented defaults", () => {
      expect(DEFAULT_MIN_SIMILARITY).toBe(0.2);
      expect(DEFAULT_MAX_EDIT_DISTANCE).toBe(2);
    });
  });

  describe("combineFuzzyRelevance", () => {
    it("clamps similarity into 0..1", () => {
      expect(combineFuzzyRelevance(2, 10)).toBe(1);
      expect(combineFuzzyRelevance(-1, 10)).toBeCloseTo(0.0727, 3);
    });

    it("lets a small edit distance lift a weak similarity", () => {
      expect(combineFuzzyRelevance(0.1, 1)).toBeCloseTo(0.4, 4);
      expect(combineFuzzyRelevance(0.7, 1)).toBeCloseTo(0.7, 4);
    });

    it("survives non-finite engine values", () => {
      expect(combineFuzzyRelevance(Number.NaN, 5)).toBeCloseTo(0.1333, 3);
      expect(combineFuzzyRelevance(0, Number.POSITIVE_INFINITY)).toBe(0);
    });
  });
});
