/**
 * Route-level API deprecation metadata (issue #142).
 *
 * `ApiDeprecationMiddleware` already existed for issue #64 and emits the
 * RFC 8594 `Sunset` header, the IETF `Deprecation` header and a `Link` to the
 * migration guide. What it lacked was a way for an individual route to opt in:
 * it matched a hard-coded prefix list that was empty, so in practice it never
 * attached a header to anything.
 *
 * This decorator is that opt-in. `@DeprecatedApi({ sunsetDate, link })` marks
 * one handler (or a whole controller), and the middleware reads that metadata
 * off the matched route. A route with no decorator is untouched, so a
 * non-deprecated request pays one metadata lookup and no header work.
 */

import { SetMetadata } from "@nestjs/common";

/** Metadata key read by `ApiDeprecationMiddleware`. */
export const DEPRECATED_API_KEY = "deprecatedApi";

export interface DeprecatedApiOptions {
  /**
   * When the deprecated surface stops being served. Must be a real date:
   * the middleware serialises it as an HTTP-date for `Sunset` and as an
   * RFC 3339 timestamp for `Deprecation`.
   */
  sunsetDate: string | Date;
  /**
   * Migration documentation. Emitted as `Link: <url>; rel="deprecation"`.
   * A successor version can be given as `successorUrl`.
   */
  link?: string;
  /** Newer API version this route should move to, if one exists. */
  successorUrl?: string;
  /**
   * Optional free-form note appended to the `Deprecation` header, per the
   * IETF draft's comment field.
   */
  note?: string;
}

export interface DeprecatedApiMetadata extends DeprecatedApiOptions {
  /** Sunset as a `Date`, normalised from whatever the caller supplied. */
  sunset: Date;
}

/**
 * Mark a route or controller as deprecated.
 *
 * @example
 * ```ts
 * @DeprecatedApi({
 *   sunsetDate: "2026-12-31",
 *   link: "https://docs.trellis.finance/migration",
 * })
 * @Get("legacy-quote")
 * legacyQuote() {}
 * ```
 */
export const DeprecatedApi = (options: DeprecatedApiOptions) =>
  SetMetadata(DEPRECATED_API_KEY, options);
