import { PipeTransform, Injectable, ArgumentMetadata } from "@nestjs/common";
import { sanitizeValueDeep } from "../sanitizers/html-sanitizer";

/**
 * Recursively sanitizes input payloads:
 * - Trims whitespace and normalizes Unicode strings.
 * - Strips script tags, event handlers, javascript:/data: URIs and all other
 *   markup via the shared sanitize-html engine.
 * - Encodes residual HTML-special characters to prevent XSS.
 * - Traverses nested objects and arrays recursively; every string at any
 *   nesting depth is sanitized.
 * - Fields declared with {@link SanitizeMarkdown} (allowMarkdown) keep the
 *   markdown-safe formatting subset; plain fields keep no markup at all.
 *
 * Applied globally via main.ts or per-controller/endpoint.
 */
@Injectable()
export class SanitizePipe implements PipeTransform {
  transform(value: unknown, _metadata?: ArgumentMetadata): unknown {
    return this.sanitize(value);
  }

  private sanitize(value: unknown): unknown {
    return sanitizeValueDeep(value);
  }
}
