import sanitizeHtmlImport from "sanitize-html";

const sanitizeHtml: typeof sanitizeHtmlImport =
  // CJS/ESM interop: sanitize-html exports the function as module.exports.
  ((sanitizeHtmlImport as unknown as { default?: typeof sanitizeHtmlImport })
    .default ?? sanitizeHtmlImport);

/**
 * HTML/XSS sanitization core shared by the SanitizePipe and the DTO
 * sanitize decorators.
 *
 * Pipeline for untrusted strings:
 *   1. trim + NFC unicode normalization,
 *   2. regex pre-pass removing script blocks (with contents), inline event
 *      handlers, javascript:/vbscript:/data:text-html URI schemes and SQL
 *      comment markers from raw text,
 *   3. a `sanitize-html` pass in *escape* mode — remaining markup is escaped
 *      (never executed), attribute payloads (onerror=, event handlers,
 *      dangerous hrefs) are stripped with their attributes.
 *   4. residual `'` and `/` are entity-encoded for defense in depth (`&`,
 *      `<`, `>`, `"` were already encoded consistently by sanitize-html).
 *
 * A dedicated markdown mode preserves the safe formatting subset (bold,
 * italic, code, links with http(s)/mailto hrefs, lists, ...) and is used for
 * fields explicitly marked as rich text.
 */

/** Markdown-safe formatting tags permitted in rich-text fields. */
const MARKDOWN_ALLOWED_TAGS = [
  "b",
  "i",
  "em",
  "strong",
  "code",
  "pre",
  "blockquote",
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "a",
];

const MARKDOWN_ALLOWED_ATTRIBUTES = { a: ["href", "title"] };
const SAFE_URI_SCHEMES = ["http", "https", "mailto"];

/** Strip all markup and dangerous content, then encode residuals. */
export function sanitizeXssString(input: string): string {
  if (!input) return input;

  // 1. Trim whitespace and normalize Unicode.
  let sanitized = input.trim().normalize("NFC");

  // 2a. Remove script tags and their contents entirely.
  sanitized = sanitized.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");

  // 2b. Remove inline event handlers (e.g. onload=..., onerror=...).
  sanitized = sanitized.replace(/on\w+\s*=\s*"[^"]*"/gi, "");
  sanitized = sanitized.replace(/on\w+\s*=\s*'[^']*'/gi, "");
  sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]+/gi, "");

  // 2c. Neutralize dangerous URI schemes in raw text.
  sanitized = sanitized.replace(/javascript\s*:/gi, "");
  sanitized = sanitized.replace(/vbscript\s*:/gi, "");
  sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, "");

  // 2d. Neutralize SQL injection comment markers.
  sanitized = sanitized.replace(/--\s*$/g, "");
  sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, "");

  // 3. sanitize-html escape pass: remaining tags are escaped (never
  //    executed) and attribute payloads are stripped with their attributes.
  sanitized = sanitizeHtml(sanitized, {
    allowedTags: [],
    allowedAttributes: {},
    allowedSchemes: SAFE_URI_SCHEMES,
    disallowedTagsMode: "escape",
  });

  // 4. Encode the characters sanitize-html leaves raw.
  sanitized = sanitized
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");

  return sanitized.trim();
}

/** Sanitize while preserving the markdown-safe formatting subset. */
export function sanitizeMarkdownString(input: string): string {
  if (!input) return input;

  const sanitized = sanitizeHtml(input.trim().normalize("NFC"), {
    allowedTags: MARKDOWN_ALLOWED_TAGS,
    allowedAttributes: MARKDOWN_ALLOWED_ATTRIBUTES,
    allowedSchemes: SAFE_URI_SCHEMES,
    allowedSchemesByTag: { a: SAFE_URI_SCHEMES },
  });

  return sanitized.trim();
}

/** Maximum recursion depth when walking nested payloads. */
export const SANITIZE_MAX_DEPTH = 50;

export interface SanitizeDeepOptions {
  /** Preserve markdown formatting tags instead of escaping all markup. */
  allowMarkdown?: boolean;
  /** Depth limit (default 50) guarding against pathological payloads. */
  maxDepth?: number;
}

/**
 * Recursively sanitize a payload: every string at any nesting depth is
 * cleaned; arrays and plain objects are traversed; Dates, RegExps, Buffers
 * and other class instances pass through untouched. Cyclic structures are
 * cut off at the depth limit instead of recursing forever.
 */
export function sanitizeValueDeep(
  value: unknown,
  options: SanitizeDeepOptions = {},
  depth = 0,
): unknown {
  const maxDepth = options.maxDepth ?? SANITIZE_MAX_DEPTH;

  if (typeof value === "string") {
    return options.allowMarkdown
      ? sanitizeMarkdownString(value)
      : sanitizeXssString(value);
  }

  if (depth >= maxDepth) {
    return typeof value === "object" && value !== null ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValueDeep(item, options, depth + 1));
  }

  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeValueDeep(val, options, depth + 1);
    }
    return sanitized;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof Date || value instanceof RegExp) return false;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}
