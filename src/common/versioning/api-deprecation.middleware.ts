/**
 * ApiDeprecationMiddleware
 *
 * Injects `Deprecation` and `Sunset` response headers on routes that are
 * served under a deprecated API version (currently: v1 routes that have a
 * v2 equivalent).  This follows RFC 8594 (The Sunset HTTP Header Field) and
 * the IETF Deprecation Header draft.
 *
 * The middleware is non-destructive — it never modifies the request or blocks
 * it.  Clients that ignore the headers continue to work until the sunset date.
 *
 * Issue: #64
 */

import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

/** Sunset date for v1 endpoints once v2 is stable. Update when v2 ships. */
const V1_SUNSET_DATE = new Date("2027-01-01T00:00:00Z");

/** Routes with a newer version equivalent.  Key = v1 path prefix. */
const DEPRECATED_PREFIXES: string[] = [
  // Expand this list as v2 endpoints ship.
  // "/api/v1/portfolio",
  // "/api/v1/auth",
];

@Injectable()
export class ApiDeprecationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.path ?? "";

    const isDeprecated = DEPRECATED_PREFIXES.some((prefix) =>
      path.startsWith(prefix),
    );

    if (isDeprecated) {
      // RFC 8594 — Sunset header (HTTP-date format)
      res.setHeader("Sunset", V1_SUNSET_DATE.toUTCString());
      // IETF Deprecation draft — ISO 8601 timestamp or "true"
      res.setHeader("Deprecation", V1_SUNSET_DATE.toISOString());
      // Link to migration guide / newer version
      res.setHeader(
        "Link",
        [
          '<https://docs.trellis.example/api/v2>; rel="successor-version"',
          '<https://docs.trellis.example/migration>; rel="deprecation"',
        ].join(", "),
      );
    }

    next();
  }
}
