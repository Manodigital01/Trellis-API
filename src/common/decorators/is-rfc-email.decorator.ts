import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { Transform } from "class-transformer";
import { isIP } from "net";

/**
 * Strict RFC 5322 (addr-spec) email validation, disposable-domain blocking and
 * canonical normalization.
 *
 * The previous implementation was a single regular expression. It rejected
 * valid quoted local parts, accepted domain labels longer than 63 octets and
 * let any throwaway-inbox provider through registration. This file replaces it
 * with a small parser that follows the addr-spec grammar (RFC 5322 §3.4.1)
 * restricted by the SMTP length limits in RFC 5321 §4.5.3.1, which is what an
 * address has to satisfy to actually receive mail.
 *
 * Deliberately NOT accepted, even though RFC 5322 technically allows them:
 * - comments and folding white space (CFWS) — obsolete in practice and a
 *   common source of parser-differential bugs;
 * - the obs-local-part / obs-domain productions;
 * - dotless domains (`user@localhost`), which cannot be delivered publicly.
 *
 * Issue #140.
 */

/** RFC 5321 §4.5.3.1: the maximum forward-path is 256 octets incl. `<` `>`. */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_LOCAL_PART_LENGTH = 64;
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_DOMAIN_LABEL_LENGTH = 63;

/** RFC 5322 §3.2.3 atext. */
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
/** RFC 1035 / RFC 1123 hostname label. */
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** A TLD must contain at least one letter (rules out `user@1.2.3.4`). */
const TLD = /^(?=.*[A-Za-z])[A-Za-z0-9-]{2,63}$/;

/**
 * Well-known disposable / temporary inbox providers. Matching also covers
 * subdomains (`foo.mailinator.com`). Extend at runtime with the
 * `DISPOSABLE_EMAIL_DOMAINS` env var or per-field via `blockedDomains`.
 */
export const DEFAULT_DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "anonbox.net",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "fakemail.net",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "incognitomail.org",
  "jetable.org",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "mailnesia.com",
  "mailsac.com",
  "mintemail.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spam4.me",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
];

/** Providers that ignore dots and `+tag` in the local part. */
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export type EmailValidationFailure =
  | "not_a_string"
  | "too_long"
  | "malformed"
  | "invalid_local_part"
  | "invalid_domain"
  | "disposable_domain";

export interface ParsedEmail {
  local: string;
  domain: string;
}

export interface RfcEmailOptions {
  /** Reject known disposable providers. Default: true. */
  blockDisposable?: boolean;
  /** Extra domains to block for this field, on top of the defaults + env. */
  blockedDomains?: readonly string[];
  /** Domains to allow even if they appear on a block list. */
  allowedDomains?: readonly string[];
}

/**
 * Split an address on its last `@` (a quoted local part may itself contain
 * `@`). Returns null when either side would be empty.
 */
function splitAddress(value: string): ParsedEmail | null {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  return { local: value.slice(0, at), domain: value.slice(at + 1) };
}

/** RFC 5322 §3.2.4 quoted-string without CFWS. */
function isValidQuotedLocalPart(local: string): boolean {
  if (local.length < 2 || !local.startsWith('"') || !local.endsWith('"')) {
    return false;
  }
  const body = local.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (body[i] === "\\") {
      // quoted-pair: `\` followed by VCHAR or WSP
      const next = body.charCodeAt(i + 1);
      if (Number.isNaN(next) || !(next === 0x09 || (next >= 0x20 && next <= 0x7e))) {
        return false;
      }
      i++;
      continue;
    }
    // qtext (%d33 / %d35-91 / %d93-126) plus a literal space
    if (code === 0x22 || code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** RFC 5322 §3.2.3 dot-atom-text. */
function isValidDotAtom(local: string): boolean {
  return local.split(".").every((atom) => ATEXT.test(atom));
}

function isValidLocalPart(local: string): boolean {
  if (local.length === 0 || local.length > MAX_LOCAL_PART_LENGTH) return false;
  return local.startsWith('"') ? isValidQuotedLocalPart(local) : isValidDotAtom(local);
}

/** RFC 5321 §4.1.3 address literal: `[1.2.3.4]` or `[IPv6:...]`. */
function isValidDomainLiteral(domain: string): boolean {
  const inner = domain.slice(1, -1);
  if (/^IPv6:/i.test(inner)) return isIP(inner.slice(5)) === 6;
  return isIP(inner) === 4;
}

function isValidDomain(domain: string): boolean {
  if (domain.startsWith("[") && domain.endsWith("]")) {
    return isValidDomainLiteral(domain);
  }
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  return (
    labels.every(
      (label) =>
        label.length <= MAX_DOMAIN_LABEL_LENGTH && DOMAIN_LABEL.test(label),
    ) && TLD.test(tld)
  );
}

/**
 * Parse an address against the addr-spec grammar. Returns the parts on
 * success or the reason it was rejected.
 */
export function parseRfcEmail(
  value: unknown,
): { ok: true; email: ParsedEmail } | { ok: false; reason: EmailValidationFailure } {
  if (typeof value !== "string") return { ok: false, reason: "not_a_string" };
  if (value.length > MAX_EMAIL_LENGTH) return { ok: false, reason: "too_long" };
  const parts = splitAddress(value);
  if (!parts) return { ok: false, reason: "malformed" };
  if (!isValidLocalPart(parts.local)) {
    return { ok: false, reason: "invalid_local_part" };
  }
  if (!isValidDomain(parts.domain)) return { ok: false, reason: "invalid_domain" };
  return { ok: true, email: parts };
}

function parseDomainList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Effective block list: defaults, plus `DISPOSABLE_EMAIL_DOMAINS`, plus any
 * per-field additions, minus `DISPOSABLE_EMAIL_ALLOWLIST` and per-field
 * allowances. Env vars are read on every call so config changes and tests
 * don't need a module reload.
 */
export function getDisposableDomains(options: RfcEmailOptions = {}): Set<string> {
  const blocked = new Set<string>([
    ...DEFAULT_DISPOSABLE_EMAIL_DOMAINS,
    ...parseDomainList(process.env.DISPOSABLE_EMAIL_DOMAINS),
    ...(options.blockedDomains ?? []).map((d) => d.toLowerCase()),
  ]);
  for (const allowed of [
    ...parseDomainList(process.env.DISPOSABLE_EMAIL_ALLOWLIST),
    ...(options.allowedDomains ?? []).map((d) => d.toLowerCase()),
  ]) {
    blocked.delete(allowed);
  }
  return blocked;
}

/** True when `domain` or any parent domain is on the block list. */
export function isDisposableEmailDomain(
  domain: string,
  options: RfcEmailOptions = {},
): boolean {
  const blocked = getDisposableDomains(options);
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (blocked.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Canonical form used for storage and lookups:
 * - surrounding whitespace trimmed, whole address lower-cased;
 * - `googlemail.com` folded into `gmail.com`;
 * - for Gmail, dots and any `+tag` suffix removed from the local part,
 *   because Gmail delivers all of those variants to the same inbox.
 *
 * Non-string input is returned unchanged so validation can report it.
 */
export function normalizeEmail<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  const parts = splitAddress(trimmed);
  if (!parts) return trimmed;

  let { local, domain } = parts;
  if (GMAIL_DOMAINS.has(domain) && !local.startsWith('"')) {
    domain = "gmail.com";
    local = local.split("+")[0].replace(/\./g, "");
    if (local.length === 0) return trimmed;
  }
  return `${local}@${domain}`;
}

@ValidatorConstraint({ name: "isRfcEmail", async: false })
export class IsRfcEmailConstraint implements ValidatorConstraintInterface {
  private failure(args?: ValidationArguments): EmailValidationFailure | null {
    const options: RfcEmailOptions = args?.constraints?.[0] ?? {};
    const parsed = parseRfcEmail(args?.value);
    if ("reason" in parsed) return parsed.reason;
    if (
      options.blockDisposable !== false &&
      isDisposableEmailDomain(parsed.email.domain, options)
    ) {
      return "disposable_domain";
    }
    return null;
  }

  validate(value: unknown, args?: ValidationArguments): boolean {
    return this.failure({ ...(args as ValidationArguments), value }) === null;
  }

  defaultMessage(args?: ValidationArguments): string {
    const property = args?.property ?? "email";
    switch (this.failure(args)) {
      case "disposable_domain": {
        const domain = String(args?.value).split("@").pop()?.toLowerCase();
        return `${property} uses a disposable email provider (${domain}); please use a permanent email address`;
      }
      case "too_long":
        return `${property} must be at most ${MAX_EMAIL_LENGTH} characters`;
      case "invalid_local_part":
        return `${property} has an invalid local part (before "@")`;
      case "invalid_domain":
        return `${property} has an invalid domain (after "@")`;
      default:
        return `${property} must be a valid RFC 5322 compliant email address`;
    }
  }
}

/**
 * Validate an email address against strict RFC 5322 addr-spec syntax and
 * reject disposable providers (unless `blockDisposable: false`).
 *
 * Validation only — pair with `@NormalizeEmail()` to canonicalize the value
 * before it reaches the service layer.
 */
export function IsRfcEmail(
  validationOptions?: ValidationOptions,
  emailOptions: RfcEmailOptions = {},
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [emailOptions],
      validator: IsRfcEmailConstraint,
    });
  };
}

/**
 * class-transformer hook that replaces the property with `normalizeEmail()`
 * output. Runs during `plainToInstance`, i.e. before validation when the
 * global ValidationPipe has `transform: true`.
 */
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }) => normalizeEmail(value));
}
