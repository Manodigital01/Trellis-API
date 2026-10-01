/**
 * Typo-tolerant matching primitives for asset lookup.
 *
 * These mirror what `pg_trgm` (`similarity`) and `fuzzystrmatch`
 * (`levenshtein`) compute in SQL, and are used in two places:
 *
 *  - ranking the rows the database returns for a fuzzy query, so the response
 *    carries a normalised `relevance` in `0..1` regardless of the engine, and
 *  - the in-memory fallback used when the extensions cannot be installed, where
 *    a cheap candidate window comes from SQL and the tolerance is applied here.
 */

export interface TypoMatchOptions {
  /** Minimum trigram similarity (`0..1`) for a match. */
  minSimilarity: number;
  /** Maximum Levenshtein edit distance for a match. */
  maxDistance: number;
}

export const DEFAULT_MIN_SIMILARITY = 0.2;
export const DEFAULT_MAX_EDIT_DISTANCE = 2;

/** Case-fold, trim and collapse internal whitespace. */
export function normalizeAssetQuery(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Escape `LIKE`/`ILIKE` metacharacters so user input cannot widen the pattern. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Classic Levenshtein edit distance (insert/delete/substitute). */
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  if (a.length === 0) {
    return b.length;
  }

  if (b.length === 0) {
    return a.length;
  }

  // Single-row dynamic programming keeps memory at O(min(a, b)).
  const previous = new Array<number>(b.length + 1);

  for (let index = 0; index <= b.length; index += 1) {
    previous[index] = index;
  }

  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = saved;
    }
  }

  return previous[b.length];
}

/**
 * Trigram similarity, matching `pg_trgm`'s definition closely enough for
 * ranking: pad so word boundaries produce trigrams, then Jaccard over the
 * trigram sets (`|intersection| / |union|`).
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const trigram of left) {
    if (right.has(trigram)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(value: string): Set<string> {
  const result = new Set<string>();

  if (!value) {
    return result;
  }

  const padded = `  ${value} `;

  if (padded.length <= 3) {
    result.add(padded);
    return result;
  }

  for (let index = 0; index <= padded.length - 3; index += 1) {
    result.add(padded.slice(index, index + 3));
  }

  return result;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Score a candidate against the query.
 *
 * Returns `null` when the candidate is not close enough, otherwise a relevance
 * in `0..1`: an exact match is `1`, and a typo scores as the better of its
 * trigram similarity and a distance-based score, so a 1-2 character typo still
 * ranks above an unrelated asset.
 *
 * The edit-distance arm additionally requires the first character to match.
 * Without it, two substitutions on a three-character ticker (`eth` vs `btc`)
 * count as "close", because edit distance says nothing about where the
 * difference is; nobody mistypes the first letter of a ticker and gets the
 * other two right, so that single rule removes the false positives without
 * losing a real typo.
 */
export function scoreTypoMatch(
  query: string,
  candidate: string,
  options: TypoMatchOptions = {
    minSimilarity: DEFAULT_MIN_SIMILARITY,
    maxDistance: DEFAULT_MAX_EDIT_DISTANCE,
  },
): number | null {
  const q = normalizeAssetQuery(query);
  const c = normalizeAssetQuery(candidate);

  if (!q || !c) {
    return null;
  }

  if (q === c) {
    return 1;
  }

  const similarity = trigramSimilarity(q, c);
  const distance = levenshtein(q, c);
  const distanceQualifies =
    q.charAt(0) === c.charAt(0) && distance <= options.maxDistance;

  if (similarity < options.minSimilarity && !distanceQualifies) {
    return null;
  }

  const distanceScore = distanceQualifies ? 0.8 / (1 + distance) : 0;
  return round4(Math.min(1, Math.max(similarity, distanceScore)));
}

export function isTypoMatch(
  query: string,
  candidate: string,
  options?: TypoMatchOptions,
): boolean {
  return scoreTypoMatch(query, candidate, options) !== null;
}

/**
 * Blend the engine's own score with the row's edit distance into the
 * `relevance` exposed to clients.
 */
export function combineFuzzyRelevance(similarity: number, distance: number): number {
  const safeSimilarity = Number.isFinite(similarity) ? Math.min(1, Math.max(0, similarity)) : 0;
  const safeDistance = Number.isFinite(distance) ? Math.max(0, distance) : Number.MAX_SAFE_INTEGER;
  const distanceScore = 0.8 / (1 + safeDistance);

  return round4(Math.min(1, Math.max(safeSimilarity, distanceScore)));
}
