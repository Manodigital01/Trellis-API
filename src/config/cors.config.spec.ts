import { ConfigService } from "@nestjs/config";
import { ServerResponse } from "http";
import {
  CorsConfigurationError,
  createCorsConfig,
  createGatewayCorsOptions,
  createOriginMatcher,
  DEV_DEFAULT_ORIGINS,
  normalizeOrigin,
  parseCorsOrigins,
  resolveAllowedOrigins,
} from "./cors.config";

type ConfigStub = Pick<ConfigService, "get">;

function configStub(values: Record<string, string | undefined>): ConfigStub {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigStub;
}

/**
 * Issue #83. These tests treat the two acceptance criteria as executable
 * statements: an origin that is not on the list must come back with *no* CORS
 * headers at all, and a production process must refuse to boot on a wildcard.
 *
 * The header assertions run the real `cors` middleware against a stub
 * Express response, because "the callback returned false" is only meaningful if
 * it actually withholds `Access-Control-Allow-Origin` on the wire.
 */
describe("CORS allow-list (#83)", () => {
  // A recording stand-in for the Express response. `cors` calls `setHeader` for
  // the headers it decides to emit, so an empty map *is* the observable
  // "no CORS headers" condition.
  function stubResponse(): {
    res: Partial<ServerResponse> & { headers: Record<string, string> };
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = {};
    const res = {
      headers,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      end: () => res,
      set: () => res,
      statusCode: 204,
    };
    return { res: res as never, headers };
  }

  function corsMiddlewareFor(values: Record<string, string | undefined>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cors = require("cors");
    return cors(createCorsConfig(configStub(values) as ConfigService));
  }

  async function runRequest(
    values: Record<string, string | undefined>,
    requestOrigin: string | undefined,
    method = "GET",
  ): Promise<Record<string, string>> {
    const middleware = corsMiddlewareFor(values);
    const { res, headers } = stubResponse();
    await new Promise<void>((resolve) => {
      middleware(
        { method, headers: { origin: requestOrigin } },
        res as never,
        // The middleware calls next() once it is done setting headers; the
        // response body is irrelevant here.
        (() => resolve()) as never,
      );
    });
    return headers;
  }

  describe("production refuses to trust the wrong configuration", () => {
    it("throws on a wildcard origin in production", () => {
      expect(() =>
        resolveAllowedOrigins("*", "production"),
      ).toThrow(CorsConfigurationError);
      expect(() => resolveAllowedOrigins("*", "production")).toThrow(
        /wildcard "\*" in production/,
      );
    });

    it("throws when production names no origins at all", () => {
      expect(() => resolveAllowedOrigins("", "production")).toThrow(
        /must list at least one explicit origin in production/,
      );
      expect(() => resolveAllowedOrigins(undefined, "production")).toThrow(
        CorsConfigurationError,
      );
      expect(() =>
        resolveAllowedOrigins("  ,  ,", "production"),
      ).toThrow(CorsConfigurationError);
    });

    it("rejects a wildcard smuggled in beside a valid origin", () => {
      expect(() =>
        resolveAllowedOrigins("https://app.trellis.finance,*", "production"),
      ).toThrow(CorsConfigurationError);
    });

    it("rejects a wildcard in development too, since credentials are enabled", () => {
      expect(() => resolveAllowedOrigins("*", "development")).toThrow(
        /list the exact origins/,
      );
    });

    it("only falls back to localhost defaults outside production", () => {
      expect(resolveAllowedOrigins("", "development")).toEqual(
        DEV_DEFAULT_ORIGINS,
      );
      expect(resolveAllowedOrigins(undefined, "test")).toEqual(
        DEV_DEFAULT_ORIGINS,
      );
      expect(() => resolveAllowedOrigins("", "production")).toThrow();
    });
  });

  describe("unauthorized origins receive no CORS headers", () => {
    const allowed = {
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://app.trellis.finance,https://*.trellis.finance",
    };

    it("emits no Access-Control-Allow-Origin for a foreign origin", async () => {
      const headers = await runRequest(allowed, "https://evil.test");

      expect(headers["access-control-allow-origin"]).toBeUndefined();
      expect(headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("emits no CORS headers for an allowed preflight either", async () => {
      const headers = await runRequest(allowed, "https://evil.test", "OPTIONS");

      expect(Object.keys(headers)).toEqual([]);
    });

    it("emits the allow-origin header for a listed origin", async () => {
      const headers = await runRequest(allowed, "https://app.trellis.finance");

      expect(headers["access-control-allow-origin"]).toBe(
        "https://app.trellis.finance",
      );
      expect(headers["access-control-allow-credentials"]).toBe("true");
    });

    it("reflects a trusted subdomain without echoing untrusted input", async () => {
      const headers = await runRequest(allowed, "https://staging.trellis.finance");

      expect(headers["access-control-allow-origin"]).toBe(
        "https://staging.trellis.finance",
      );
    });

    it.each([
      "https://trellis.finance.evil.test",
      "https://evil.test?next=https://app.trellis.finance",
      "https://app.trellis.finance.evil.test",
      "https://nottrellis.finance",
      "http://app.trellis.finance",
      "https://app.trellis.finance/attacker",
      "https://app.trellis.finance:8443.evil.test",
      "null",
      "https://APP.TRELLIS.FINANCE.evil.test",
    ])("refuses %s", async (origin) => {
      const headers = await runRequest(allowed, origin);

      expect(headers["access-control-allow-origin"]).toBeUndefined();
    });

    // A request with no Origin header is not cross-origin (curl, a mobile
    // client, same-origin navigation) and must keep working.
    it("does not gate requests that carry no Origin header", async () => {
      const headers = await runRequest(allowed, undefined);

      expect(headers["access-control-allow-origin"]).toBeUndefined();
      expect(headers["vary"]).toBe("Origin");
    });
  });

  describe("origin parsing", () => {
    it("trims, lowercases and de-duplicates a configured list", () => {
      expect(
        parseCorsOrigins(" https://App.Trellis.Finance , https://app.trellis.finance ,, "),
      ).toEqual(["https://app.trellis.finance"]);
    });

    it("drops default ports and keeps explicit ones", () => {
      expect(normalizeOrigin("https://app.trellis.finance:443")).toBe(
        "https://app.trellis.finance",
      );
      expect(normalizeOrigin("http://localhost:3001")).toBe(
        "http://localhost:3001",
      );
    });

    it("rejects values that are not bare origins", () => {
      expect(normalizeOrigin("app.trellis.finance")).toBeNull();
      expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
      expect(normalizeOrigin("https://user:pass@app.trellis.finance")).toBeNull();
      expect(normalizeOrigin("https://app.trellis.finance/hook")).toBeNull();
      expect(normalizeOrigin("")).toBeNull();
    });
  });

  describe("subdomain matching", () => {
    const isAllowed = createOriginMatcher([
      "https://app.trellis.finance",
      "https://*.trellis.finance",
    ]);

    it("trusts subdomains at any depth", () => {
      expect(isAllowed("https://app.trellis.finance")).toBe(true);
      expect(isAllowed("https://eu.app.trellis.finance")).toBe(true);
    });

    // `*` in DNS terms does not cover the apex, so an operator who wants the
    // apex trusted has to say so.
    it("does not extend to the apex it is scoped under", () => {
      expect(isAllowed("https://trellis.finance")).toBe(false);
    });

    it("cannot be walked outwards to an attacker-controlled host", () => {
      expect(isAllowed("https://trellis.finance.attacker.test")).toBe(false);
      expect(isAllowed("https://trellis.finance")).toBe(false);
    });

    it("cannot widen an https entry to the same host over plaintext", () => {
      expect(isAllowed("http://app.trellis.finance")).toBe(false);
    });

    it("rejects a malformed wildcard entry at configuration time", () => {
      expect(() => createOriginMatcher(["*"])).toThrow(
        CorsConfigurationError,
      );
      expect(() => createOriginMatcher(["*.*.trellis.finance"])).toThrow(
        /leftmost label/,
      );
      expect(() => createOriginMatcher(["https://app.*.trellis.finance"])).toThrow(
        /leftmost label/,
      );
      expect(() => createOriginMatcher(["app.trellis.finance"])).toThrow(
        /expected a full origin/,
      );
      expect(() => createOriginMatcher(["https://app.trellis.finance/hook"])).toThrow(
        /expected a full origin/,
      );
    });
  });

  describe("environment wiring", () => {
    it("prefers the explicit allow-list over the legacy variable", async () => {
      const headers = await runRequest(
        {
          NODE_ENV: "production",
          CORS_ALLOWED_ORIGINS: "https://new.trellis.finance",
          CORS_ORIGIN: "https://old.trellis.finance",
        },
        "https://old.trellis.finance",
      );

      expect(headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("still honours the legacy variable when no allow-list is set", async () => {
      const headers = await runRequest(
        {
          NODE_ENV: "production",
          CORS_ORIGIN: "https://old.trellis.finance",
        },
        "https://old.trellis.finance",
      );

      expect(headers["access-control-allow-origin"]).toBe(
        "https://old.trellis.finance",
      );
    });

    it("reads localhost defaults in development", async () => {
      const headers = await runRequest(
        { NODE_ENV: "development" },
        "http://localhost:3001",
      );

      expect(headers["access-control-allow-origin"]).toBe(
        "http://localhost:3001",
      );
    });
  });

  describe("websocket gateways", () => {
    it("applies the same allow-list to a handshake origin", () => {
      const options = createGatewayCorsOptions(() => "https://app.trellis.finance");
      const decide = (origin: string, callback: (e: null, ok: boolean) => void) =>
        (options.origin as (o: string, cb: typeof callback) => void)(
          origin,
          callback,
        );

      const allow: boolean[] = [];
      decide("https://app.trellis.finance", (_e, ok) => allow.push(ok));
      decide("https://evil.test", (_e, ok) => allow.push(ok));

      expect(allow).toEqual([true, false]);
    });

    it("fails closed when the gateway allow-list is a wildcard", () => {
      const options = createGatewayCorsOptions(() => "*");
      let allowed: boolean | undefined;
      (options.origin as (o: string, cb: (e: null, ok: boolean) => void) => void)(
        "https://evil.test",
        (_e, ok) => (allowed = ok),
      );

      expect(allowed).toBe(false);
    });

    it("fails closed in production with no allow-list configured", () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const options = createGatewayCorsOptions(() => undefined);
        let allowed: boolean | undefined;
        (
          options.origin as (o: string, cb: (e: null, ok: boolean) => void) => void
        )("https://app.trellis.finance", (_e, ok) => (allowed = ok));

        expect(allowed).toBe(false);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });
});
