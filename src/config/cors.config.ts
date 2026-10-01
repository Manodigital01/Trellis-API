import { ConfigService } from "@nestjs/config";
import { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

/**
 * Explicit CORS allow-listing (issue #83).
 *
 * The previous configuration split `CORS_ORIGIN` on commas and compared the
 * result to the request `Origin` header, which meant any of three things could
 * widen the API to the whole internet: an unset variable silently falling back
 * to a single dev origin, a stray `*` entry being honoured verbatim, and a
 * malformed entry (`*`, `*.trellis.finance`, a bare hostname, `"null"`) being
 * accepted because nothing ever parsed it. This module makes the list explicit,
 * parses every entry, and refuses to serve a credentialed API to a wildcard.
 *
 * Shape of a permitted entry:
 *
 *   https://app.trellis.finance     exact origin, compared literally
 *   https://*.trellis.finance       any single-or-multi subdomain of the apex
 *   http://localhost:3001           explicit port for local development
 *
 * Everything else — a bare hostname, a path, a query, a `*` on its own, an
 * opaque `"null"` origin — is rejected at startup, because a mistake in this
 * list silently grants cross-origin access to an authenticated API.
 */

/** The literal that used to be accepted as "any origin". */
export const WILDCARD_ORIGIN = "*";

/** Used only when no allow-list is configured and we are not in production. */
export const DEV_DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
];

const ALLOWED_SCHEMES = new Set(["http", "https", "ws", "wss"]);

/** `https://*.example.com` — the only shape of wildcard this module accepts. */
const SUBDOMAIN_WILDCARD = /^https?:\/\/\*\./;

/** Port that is implied by the scheme and therefore never sent by a browser. */
const DEFAULT_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  ws: "80",
  wss: "443",
};

export class CorsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorsConfigurationError";
  }
}

export interface CorsOriginRule {
  /** The configured entry, normalised. */
  origin: string;
  /**
   * Set for trusted-subdomain entries such as `https://*.trellis.finance`.
   * Anchored at both ends so `https://trellis.finance.evil.test` and
   * `https://evil.test?x=.trellis.finance` cannot match.
   */
  subdomainPattern?: RegExp;
}

/**
 * Split a comma-separated allow-list into normalised origins, dropping blanks
 * and duplicates. Parsing is deliberately lenient about whitespace and case
 * (a URL host is case-insensitive) and strict about everything else.
 */
export function parseCorsOrigins(raw: string | string[] | undefined | null): string[] {
  const entries = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  const normalized = entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeOrigin(entry) ?? entry.toLowerCase());

  return [...new Set(normalized)];
}

/**
 * Reduce an origin to the form a browser actually sends: lowercase scheme and
 * host, and no explicit default port. Returns `null` for anything that is not a
 * bare origin (path, query, credentials, fragment) or is not parseable.
 */
export function normalizeOrigin(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol.replace(/:$/, "").toLowerCase())) {
    return null;
  }
  if (
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }
  if (!parsed.hostname) return null;

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port;
  const authority =
    port && port !== DEFAULT_PORTS[scheme] ? `${host}:${port}` : host;
  return `${scheme}://${authority}`;
}

/** Wildcard subdomain entries (`https://*.trellis.finance`) are trusted. */
export function isSubdomainWildcardOrigin(value: string): boolean {
  return SUBDOMAIN_WILDCARD.test(value.trim().toLowerCase());
}


export function isWildcardOrigin(value: string): boolean {
  return value.trim() === WILDCARD_ORIGIN;
}

/**
 * Build a matcher rule for one configured entry, or throw explaining why the
 * entry cannot be trusted.
 */
export function buildOriginRule(value: string): CorsOriginRule {
  const entry = value.trim().toLowerCase();

  if (isWildcardOrigin(entry)) {
    throw new CorsConfigurationError(
      `Invalid CORS origin "${value}": the wildcard "${WILDCARD_ORIGIN}" cannot be allowed by a credentialed API. List the exact origins instead, or use "https://*.example.com" to trust a subdomain.`,
    );
  }

  if (isSubdomainWildcardOrigin(entry)) {
    const scheme = entry.slice(0, entry.indexOf("://"));
    const suffix = entry.replace(SUBDOMAIN_WILDCARD, "").replace(/:\d+$/, "");
    if (!suffix || suffix.includes("*") || !/^[a-z0-9.-]+$/.test(suffix)) {
      throw new CorsConfigurationError(
        `Invalid CORS origin "${value}": a subdomain wildcard may only appear as the leftmost label, e.g. "https://*.trellis.finance".`,
      );
    }
    // The apex is deliberately not matched: `*.trellis.finance` trusts the
    // subdomains, and the apex itself has to be listed on its own. The scheme is
    // pinned to the one that was configured, so an https entry cannot be used to
    // hand a plaintext origin the same trust.
    const labels = suffix.split(".").filter(Boolean);
    const labelPattern = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
    const pattern = new RegExp(
      `^${scheme}://(?:${labelPattern}\\.)+${labels
        .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\.")}(?::\\d{1,5})?$`,
    );
    return { origin: entry, subdomainPattern: pattern };
  }

  // Any other use of `*` (a bare wildcard, `https://*.*.example.com`) is
  // refused before it can reach the URL parser.
  if (entry.includes("*")) {
    throw new CorsConfigurationError(
      `Invalid CORS origin "${value}": a wildcard may only appear as the leftmost label, e.g. "https://*.trellis.finance".`,
    );
  }

  const normalized = normalizeOrigin(entry);
  if (!normalized) {
    throw new CorsConfigurationError(
      `Invalid CORS origin "${value}": expected a full origin such as "https://app.trellis.finance" (scheme, host and optional port, no path).`,
    );
  }
  return { origin: normalized };
}

/** Compile a validated allow-list into a predicate over request origins. */
export function createOriginMatcher(origins: string[]): (origin: string) => boolean {
  const rules = origins.map(buildOriginRule);
  return (origin: string | undefined | null): boolean => {
    // A request without an `Origin` header is not a browser cross-origin
    // request (curl, server-to-server, same-origin navigations) and is out of
    // CORS' scope entirely.
    if (!origin) return true;
    // An opaque origin ("null" — a sandboxed iframe, a file:// document, a
    // redirect from a data: URL) identifies nothing that can be allow-listed,
    // so it is refused rather than pattern-matched.
    if (origin.toLowerCase() === "null") return false;

    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;

    return rules.some(
      (rule) =>
        rule.origin === normalized ||
        (rule.subdomainPattern ? rule.subdomainPattern.test(normalized) : false),
    );
  };
}

/**
 * Resolve and validate the allow-list for the current environment.
 *
 * Production must name its origins: an unset or wildcard list is a hard startup
 * failure rather than a silent fallback, because the fallback would decide who
 * can read an authenticated API.
 */
export function resolveAllowedOrigins(
  raw: string | string[] | undefined | null,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string[] {
  const isProduction = nodeEnv === "production";
  const origins = parseCorsOrigins(raw);

  // `*` never survives parsing into a usable rule, but say so explicitly: a
  // wildcard is the exact configuration this issue is about.
  if (raw && !Array.isArray(raw) && isWildcardOrigin(raw)) {
    throw new CorsConfigurationError(
      isProduction
        ? 'CORS origins must not be the wildcard "*" in production. Set CORS_ALLOWED_ORIGINS to an explicit comma-separated list of origins.'
        : `CORS origins must not be the wildcard "${WILDCARD_ORIGIN}"; list the exact origins instead.`,
    );
  }

  origins.forEach(buildOriginRule);

  if (origins.length === 0) {
    if (isProduction) {
      throw new CorsConfigurationError(
        "CORS_ALLOWED_ORIGINS must list at least one explicit origin in production (comma-separated, e.g. \"https://app.trellis.finance,https://*.trellis.finance\").",
      );
    }
    return [...DEV_DEFAULT_ORIGINS];
  }

  return origins;
}

/**
 * Resolve the allow-list from the environment. `CORS_ALLOWED_ORIGINS` is the
 * explicit whitelist; `CORS_ORIGIN` is still read so existing deployments keep
 * working, but a single wildcard there is rejected the same way.
 */
export function readAllowedOrigins(
  configService: Pick<ConfigService, "get">,
): string[] {
  const allowed = configService.get<string | undefined>("CORS_ALLOWED_ORIGINS");
  const legacy = configService.get<string | undefined>("CORS_ORIGIN");
  const raw =
    parseCorsOrigins(allowed).length > 0 ? allowed : legacy;
  const nodeEnv = configService.get<string | undefined>("NODE_ENV");
  return resolveAllowedOrigins(raw, nodeEnv);
}

export function createCorsConfig(configService: ConfigService): CorsOptions {
  const isOriginAllowed = createOriginMatcher(readAllowedOrigins(configService));

  return {
    origin: (origin, callback) => {
      // A refused origin is answered *without* CORS headers rather than as an
      // error: the browser then blocks the response, while the request itself
      // stays a normal 2xx/4xx the client can log. Throwing here would turn
      // every cross-origin probe into a 500 and pollute the error budget.
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: ["X-Total-Count"],
    maxAge: 3600,
    optionsSuccessStatus: 204,
  };
}

/**
 * CORS options for the WebSocket gateways.
 *
 * The gateways were configured with `origin: "*"` and `credentials: true`, the
 * same wildcard this issue removes from the HTTP layer, and they carry
 * authenticated sessions. The allow-list is read per handshake rather than at
 * import time, because the gateway decorator is evaluated while the module graph
 * is being loaded — before `ConfigModule` has read `.env`.
 */
export function createGatewayCorsOptions(
  readEnv: () => string | string[] | undefined = () =>
    process.env.CORS_ALLOWED_ORIGINS ?? process.env.CORS_ORIGIN,
): CorsOptions {
  return {
    origin: (origin, callback) => {
      let allowed = false;
      try {
        allowed = createOriginMatcher(
          resolveAllowedOrigins(readEnv(), process.env.NODE_ENV),
        )(origin);
      } catch {
        // A misconfigured gateway allow-list must not silently open up, and it
        // must not crash the handshake either: refuse every origin.
        allowed = false;
      }
      callback(null, allowed);
    },
    credentials: true,
  };
}
