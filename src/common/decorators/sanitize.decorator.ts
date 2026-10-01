import { Transform, TransformFnParams } from "class-transformer";
import {
  sanitizeMarkdownString,
  sanitizeValueDeep,
} from "../sanitizers/html-sanitizer";

/**
 * Class-transformer decorator that automatically trims leading and trailing whitespace from string properties.
 */
export function Trim() {
  return Transform(({ value }: TransformFnParams) => {
    if (typeof value === "string") {
      return value.trim();
    }
    return value;
  });
}

/**
 * Class-transformer decorator that sanitizes string properties to prevent XSS payloads and normalizes unicode characters.
 */
export function SanitizeString() {
  return Transform(({ value }: TransformFnParams) => {
    if (typeof value === "string") {
      // Recursive engine: strips markup, event handlers and dangerous URI
      // schemes, then encodes residual HTML-special characters.
      return sanitizeValueDeep(value);
    }
    // Nested objects / arrays assigned to a single DTO property are walked
    // recursively so XSS vectors cannot hide at depth.
    return sanitizeValueDeep(value);
  });
}

/**
 * Sanitizes a property recursively while preserving the markdown-safe
 * formatting subset (bold, italic, code, links with http(s)/mailto hrefs,
 * lists, ...). Use on rich-text fields such as bios, descriptions or
 * comments where formatting is intentional.
 */
export function SanitizeMarkdown() {
  return Transform(({ value }: TransformFnParams) => {
    return sanitizeValueDeep(value, { allowMarkdown: true });
  });
}

/**
 * Sanitizes an entire nested payload (object or array) recursively. Apply to
 * DTO properties typed as nested structures so every string at any depth is
 * cleaned — including array elements and child objects.
 */
export function SanitizeNested() {
  return Transform(({ value }: TransformFnParams) => {
    return sanitizeValueDeep(value);
  });
}
