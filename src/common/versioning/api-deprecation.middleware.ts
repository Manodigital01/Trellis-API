/**
 * ApiDeprecationMiddleware
 *
 * Emits `Deprecation`, `Sunset` and `Link` response headers on deprecated API
 * surfaces, per RFC 8594 (The Sunset HTTP Header Field) and the IETF
 * Deprecation Header draft.
 *
 * Two sources feed it, and a route can be deprecated by either:
 *
 *  1. `@DeprecatedApi({ sunsetDate, link })` on the handler (issue #142).
 *     Read straight off the matched handler, so the per-route sunset date and
 *     migration link come from the route itself.
 *  2. The prefix list below, for a whole API version that is being retired
 *     (issue #64).
 *
 * The middleware is non-destructive: it never modifies the request and never
 * blocks it. A client that ignores the headers keeps working until sunset.
 *
 * A route matched by neither source is left completely alone — no header is
 * set and no date is formatted, so the common case costs one metadata lookup.
 */

import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import {
  DEPRECATED_API_KEY,
  DeprecatedApiMetadata,
  DeprecatedApiOptions,
} from "./deprecated-api.decorator";

/** Sunset date for a version-wide deprecation. Update when the successor ships. */
const V1_SUNSET_DATE = new Date("2027-01-01T00:00:00Z");

/** Routes with a newer version equivalent. Key = path prefix. */
const DEPRECATED_PREFIXES: string[] = [
  // Expand this list as successor endpoints ship. A prefix here deprecates
  // every route beneath it, which is the right tool for retiring a whole API
  // version and the wrong one for a single route -- use @DeprecatedApi there.
];

/**
 * Normalise whatever the decorator stored into a usable metadata object.
 *
 * Exported for the middleware's own tests: the validation rules are the part
 * worth pinning, and they are pure.
 */
export function resolveDeprecatedMetadata(
  raw: unknown,
): DeprecatedApiMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const options = raw as DeprecatedApiOptions;

  let sunset: Date;
  if (options.sunsetDate instanceof Date) {
    sunset = options.sunsetDate;
  } else if (typeof options.sunsetDate === "string" || typeof options.sunsetDate === "number") {
    sunset = new Date(options.sunsetDate);
  } else {
    return null;
  }

  // An unparseable date would serialise as "Invalid Date" in a response
  // header, which is worse than emitting nothing: a client cannot act on it.
  if (Number.isNaN(sunset.getTime())) return null;

  // A sunset already in the past is legitimate (that is what "sunset" means
  // after the fact) and is preserved, so only non-finite dates are rejected.
  return { ...options, sunset };
}

/**
 * Build the header values for one deprecation.
 *
 * Split out so the exact header strings can be asserted without constructing a
 * request or a response.
 */
export function buildDeprecationHeaders(
  metadata: DeprecatedApiMetadata,
): Record<string, string> {
  const headers: Record<string, string> = {
    // RFC 8594 — Sunset, in HTTP-date format.
    Sunset: metadata.sunset.toUTCString(),
  };

  // IETF Deprecation draft — an RFC 3339 timestamp, optionally with a comment.
  headers.Deprecation = metadata.note
    ? `${metadata.sunset.toISOString()}; ${metadata.note}`
    : metadata.sunset.toISOString();

  const links: string[] = [];
  if (metadata.link) links.push(`<${metadata.link}>; rel="deprecation"`);
  if (metadata.successorUrl) {
    links.push(`<${metadata.successorUrl}>; rel="successor-version"`);
  }
  if (links.length > 0) headers.Link = links.join(", ");

  return headers;
}

@Injectable()
export class ApiDeprecationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Per-route opt-in (issue #142).
    const metadata = this.readRouteMetadata(req);
    if (metadata) {
      const headers = buildDeprecationHeaders(metadata);
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      return next();
    }

    // Version-wide opt-in (issue #64).
    const path = req.path ?? "";
    if (DEPRECATED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      const headers = buildDeprecationHeaders({
        sunsetDate: V1_SUNSET_DATE,
        sunset: V1_SUNSET_DATE,
        link: "https://docs.trellis.example/migration",
        successorUrl: "https://docs.trellis.example/api/v2",
      });
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
    }

    next();
  }

  /**
   * Read `@DeprecatedApi` off the matched route.
   *
   * Express puts the route handlers on `req.route.stack` after routing, and
   * Nest attaches the metadata to the handler function itself, so the lookup
   * walks that stack. Before routing (a 404, or a middleware mounted above
   * the router) there is nothing to read and the route is left alone.
   */
  private readRouteMetadata(req: Request): DeprecatedApiMetadata | null {
    const route = (req as any).route;
    const stack = route?.stack;
    if (!Array.isArray(stack)) return null;

    for (const layer of stack) {
      const handler = layer?.handle;
      if (typeof handler !== "function") continue;
      const raw = Reflect.getMetadata?.(DEPRECATED_API_KEY, handler);
      const metadata = resolveDeprecatedMetadata(raw);
      if (metadata) return metadata;
    }
    return null;
  }
}
