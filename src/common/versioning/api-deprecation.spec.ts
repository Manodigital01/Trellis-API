import "reflect-metadata";
import {
  ApiDeprecationMiddleware,
  buildDeprecationHeaders,
  resolveDeprecatedMetadata,
} from "./api-deprecation.middleware";
import { DEPRECATED_API_KEY, DeprecatedApi } from "./deprecated-api.decorator";

/**
 * Issue #142. The middleware already emitted the three headers for a
 * hard-coded prefix list that was empty, so it never fired. These tests cover
 * the route-level opt-in the issue asked for, and pin the two properties that
 * matter operationally: a decorated route gets the headers, and an undecorated
 * route is left completely untouched.
 */

/** Minimal stand-ins for the Express req/res the middleware touches. */
function makeRequest(options: {
  path?: string;
  handlers?: Array<(...args: any[]) => any>;
}): any {
  return {
    path: options.path ?? "/api/v1/thing",
    route: options.handlers ? { stack: options.handlers.map((handle) => ({ handle })) } : undefined,
  };
}

function makeResponse(): { headers: Record<string, string>; setHeader: jest.Mock } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
      return undefined;
    }),
  };
}

describe("resolveDeprecatedMetadata (#142)", () => {
  it("normalises a string sunset date to a Date", () => {
    const resolved = resolveDeprecatedMetadata({
      sunsetDate: "2026-12-31",
      link: "https://docs.trellis.finance/migration",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.sunset).toBeInstanceOf(Date);
    expect(resolved!.sunset.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("passes a Date through unchanged", () => {
    const sunset = new Date("2027-06-30T12:00:00Z");
    expect(resolveDeprecatedMetadata({ sunsetDate: sunset })!.sunset).toEqual(sunset);
  });

  it("preserves a sunset date that has already passed", () => {
    // "Sunset" is meaningful after the fact too: a client reading the header
    // late still needs the real date rather than a rejection.
    const resolved = resolveDeprecatedMetadata({ sunsetDate: "2020-01-01" });
    expect(resolved).not.toBeNull();
    expect(resolved!.sunset.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("rejects an unparseable date rather than emitting Invalid Date", () => {
    // `new Date("not-a-date").toUTCString()` is "Invalid Date", which a client
    // cannot act on. Emitting nothing is strictly better.
    expect(resolveDeprecatedMetadata({ sunsetDate: "not-a-date" })).toBeNull();
  });

  it("rejects missing or malformed metadata", () => {
    expect(resolveDeprecatedMetadata(undefined)).toBeNull();
    expect(resolveDeprecatedMetadata(null)).toBeNull();
    expect(resolveDeprecatedMetadata("nope")).toBeNull();
    expect(resolveDeprecatedMetadata({})).toBeNull();
    expect(resolveDeprecatedMetadata({ link: "https://x" })).toBeNull();
  });
});

describe("buildDeprecationHeaders (#142)", () => {
  it("emits Sunset as an HTTP-date and Deprecation as RFC 3339", () => {
    const headers = buildDeprecationHeaders({
      sunsetDate: "2026-12-31",
      sunset: new Date("2026-12-31T00:00:00Z"),
    });

    expect(headers.Sunset).toBe("Thu, 31 Dec 2026 00:00:00 GMT");
    expect(headers.Deprecation).toBe("2026-12-31T00:00:00.000Z");
  });

  it("emits Link with rel=deprecation when a migration link is given", () => {
    const headers = buildDeprecationHeaders({
      sunsetDate: "2026-12-31",
      sunset: new Date("2026-12-31T00:00:00Z"),
      link: "https://docs.trellis.finance/migration",
    });

    expect(headers.Link).toBe('<https://docs.trellis.finance/migration>; rel="deprecation"');
  });

  it("emits both Link relations when a successor version is given", () => {
    const headers = buildDeprecationHeaders({
      sunsetDate: "2026-12-31",
      sunset: new Date("2026-12-31T00:00:00Z"),
      link: "https://docs.trellis.finance/migration",
      successorUrl: "https://docs.trellis.finance/api/v2",
    });

    expect(headers.Link).toContain('rel="deprecation"');
    expect(headers.Link).toContain('rel="successor-version"');
  });

  it("omits Link entirely when no documentation URL is configured", () => {
    const headers = buildDeprecationHeaders({
      sunsetDate: "2026-12-31",
      sunset: new Date("2026-12-31T00:00:00Z"),
    });
    expect(headers.Link).toBeUndefined();
  });

  it("appends a note to Deprecation as the draft's comment field", () => {
    const headers = buildDeprecationHeaders({
      sunsetDate: "2026-12-31",
      sunset: new Date("2026-12-31T00:00:00Z"),
      note: "use /api/v2/quotes",
    });
    expect(headers.Deprecation).toBe("2026-12-31T00:00:00.000Z; use /api/v2/quotes");
  });
});

describe("ApiDeprecationMiddleware with @DeprecatedApi (#142)", () => {
  let middleware: ApiDeprecationMiddleware;

  beforeEach(() => {
    middleware = new ApiDeprecationMiddleware();
  });

  it("attaches Deprecation, Sunset and Link to a decorated route", () => {
    class LegacyController {
      @DeprecatedApi({
        sunsetDate: "2026-12-31",
        link: "https://docs.trellis.finance/migration",
      })
      legacyQuote(): void {
        /* route handler */
      }
    }

    const req = makeRequest({ handlers: [LegacyController.prototype.legacyQuote] });
    const res = makeResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(res.headers.Deprecation).toBe("2026-12-31T00:00:00.000Z");
    expect(res.headers.Sunset).toBe("Thu, 31 Dec 2026 00:00:00 GMT");
    expect(res.headers.Link).toContain('rel="deprecation"');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-deprecated route completely untouched", () => {
    class CurrentController {
      currentQuote(): void {
        /* not deprecated */
      }
    }

    const req = makeRequest({ handlers: [CurrentController.prototype.currentQuote] });
    const res = makeResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    // The acceptance criterion: no additional header overhead on routes that
    // are not deprecated.
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.headers.Deprecation).toBeUndefined();
    expect(res.headers.Sunset).toBeUndefined();
    expect(res.headers.Link).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("always calls next so the request is never blocked", () => {
    class LegacyController {
      @DeprecatedApi({ sunsetDate: "2026-12-31" })
      legacy(): void {
        /* deprecated */
      }
    }
    const res = makeResponse();
    const next = jest.fn();

    middleware.use(makeRequest({ handlers: [LegacyController.prototype.legacy] }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never modifies the request", () => {
    class LegacyController {
      @DeprecatedApi({ sunsetDate: "2026-12-31" })
      legacy(): void {
        /* deprecated */
      }
    }
    const req = makeRequest({ handlers: [LegacyController.prototype.legacy] });
    const before = JSON.stringify({ path: req.path });

    middleware.use(req, makeResponse(), jest.fn());

    expect(JSON.stringify({ path: req.path })).toBe(before);
  });

  it("ignores a decorated route whose sunset date is unparseable", () => {
    class BrokenController {
      @DeprecatedApi({ sunsetDate: "garbage" })
      broken(): void {
        /* bad date */
      }
    }
    const res = makeResponse();

    middleware.use(makeRequest({ handlers: [BrokenController.prototype.broken] }), res, jest.fn());

    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("handles a request that never reached routing (404, or middleware above the router)", () => {
    const res = makeResponse();
    const next = jest.fn();

    middleware.use(makeRequest({ path: "/api/v1/missing" }), res, next);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("picks the first decorated handler when a route has a stack of several", () => {
    class LegacyController {
      @DeprecatedApi({ sunsetDate: "2026-12-31" })
      legacy(): void {
        /* deprecated */
      }
    }
    class OtherController {
      plain(): void {
        /* not deprecated */
      }
    }

    const res = makeResponse();
    middleware.use(
      makeRequest({
        handlers: [OtherController.prototype.plain, LegacyController.prototype.legacy],
      }),
      res,
      jest.fn(),
    );

    expect(res.headers.Sunset).toBe("Thu, 31 Dec 2026 00:00:00 GMT");
  });

  it("skips non-function stack entries without throwing", () => {
    const res = makeResponse();
    const req: any = {
      path: "/api/v1/thing",
      route: { stack: [{ handle: undefined }, { handle: "not a function" }] },
    };

    expect(() => middleware.use(req, res, jest.fn())).not.toThrow();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("stores its metadata under a stable key", () => {
    expect(DEPRECATED_API_KEY).toBe("deprecatedApi");
  });
});
