import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  IsRfcEmail,
  NormalizeEmail,
  isDisposableEmailDomain,
  normalizeEmail,
  parseRfcEmail,
} from "./is-rfc-email.decorator";

class TestUserEmailDto {
  @IsRfcEmail()
  email!: string;
}

class AllowDisposableDto {
  @IsRfcEmail(undefined, { blockDisposable: false })
  email!: string;
}

class CustomBlockListDto {
  @IsRfcEmail(undefined, {
    blockedDomains: ["blocked.example"],
    allowedDomains: ["mailinator.com"],
  })
  email!: string;
}

class RegisterLikeDto {
  @NormalizeEmail()
  @IsRfcEmail()
  email!: string;
}

async function errorsFor(dto: object) {
  return validate(dto);
}

function dtoWith(email: unknown): TestUserEmailDto {
  const dto = new TestUserEmailDto();
  dto.email = email as string;
  return dto;
}

describe("IsRfcEmail Decorator", () => {
  const originalBlock = process.env.DISPOSABLE_EMAIL_DOMAINS;
  const originalAllow = process.env.DISPOSABLE_EMAIL_ALLOWLIST;

  afterEach(() => {
    process.env.DISPOSABLE_EMAIL_DOMAINS = originalBlock;
    process.env.DISPOSABLE_EMAIL_ALLOWLIST = originalAllow;
    if (originalBlock === undefined) delete process.env.DISPOSABLE_EMAIL_DOMAINS;
    if (originalAllow === undefined) delete process.env.DISPOSABLE_EMAIL_ALLOWLIST;
  });

  describe("RFC 5322 syntax", () => {
    it.each([
      "user@example.com",
      "user.name+tag@example.co.uk",
      "user_name@sub.domain.org",
      "user-name123@domain.io",
      "disposable.style.email.with+symbol@example.com",
      "x@example.com",
      "!#$%&'*+/=?^_`{|}~-@example.com",
      '"john doe"@example.com',
      '"very.(),:;<>[]\\".VERY.\\"very@\\\\ \\"very\\".unusual"@example.com',
      '"a@b"@example.com',
      "user@[192.168.0.1]",
      "user@[IPv6:2001:db8::1]",
      "user@xn--bcher-kva.example",
      "user@123.example.com",
      "a".repeat(64) + "@example.com",
    ])("accepts %s", async (email) => {
      expect(await errorsFor(dtoWith(email))).toHaveLength(0);
    });

    it.each([
      "",
      "plainaddress",
      "@no-local.com",
      "no-at-sign.com",
      "user@",
      "user@.com",
      "user@domain..com",
      "user@-domain.com",
      "user@domain-.com",
      "user@localhost",
      "user@example.c",
      "user@example.123",
      "user@1.2.3.4",
      "user@[999.1.1.1]",
      "user@[IPv6:not-an-ip]",
      ".user@example.com",
      "user.@example.com",
      "user..name@example.com",
      "user name@example.com",
      "user@exa mple.com",
      "a@b@example.com",
      '"unterminated@example.com',
      '"bad"quote"@example.com',
      "user(comment)@example.com",
      "üser@example.com",
      "a".repeat(65) + "@example.com",
      "user@" + "a".repeat(64) + ".com",
      "user@" + "a".repeat(250) + ".com",
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.com`,
    ])("rejects %s", async (email) => {
      const errors = await errorsFor(dtoWith(email));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe("email");
    });

    it.each([12345, null, undefined, {}, ["a@example.com"]])(
      "rejects non-string %p",
      async (email) => {
        expect((await errorsFor(dtoWith(email))).length).toBeGreaterThan(0);
      },
    );

    it("reports why a value was rejected", () => {
      expect(parseRfcEmail("nope")).toEqual({ ok: false, reason: "malformed" });
      expect(parseRfcEmail("a..b@example.com")).toEqual({
        ok: false,
        reason: "invalid_local_part",
      });
      expect(parseRfcEmail("a@example")).toEqual({
        ok: false,
        reason: "invalid_domain",
      });
      expect(parseRfcEmail("a".repeat(250) + "@x.com")).toEqual({
        ok: false,
        reason: "too_long",
      });
      expect(parseRfcEmail(42)).toEqual({ ok: false, reason: "not_a_string" });
    });

    it("produces a field-specific syntax error message", async () => {
      const [error] = await errorsFor(dtoWith("user@domain..com"));
      expect(error.constraints?.isRfcEmail).toBe(
        'email has an invalid domain (after "@")',
      );
    });
  });

  describe("disposable domains", () => {
    it.each([
      ["bot@mailinator.com", "mailinator.com"],
      ["bot@MAILINATOR.COM", "mailinator.com"],
      ["bot@tempmail.com", "tempmail.com"],
      ["bot@guerrillamail.com", "guerrillamail.com"],
      ["bot@yopmail.com", "yopmail.com"],
      ["bot@10minutemail.com", "10minutemail.com"],
      ["bot@inbox.mailinator.com", "inbox.mailinator.com"],
    ])("rejects %s with a descriptive message", async (email, domain) => {
      const [error] = await errorsFor(dtoWith(email));
      expect(error.property).toBe("email");
      expect(error.constraints?.isRfcEmail).toBe(
        `email uses a disposable email provider (${domain}); please use a permanent email address`,
      );
    });

    it("does not match look-alike domains", () => {
      expect(isDisposableEmailDomain("notmailinator.com")).toBe(false);
      expect(isDisposableEmailDomain("mailinator.com.example.org")).toBe(false);
    });

    it("can be disabled per field", async () => {
      const dto = new AllowDisposableDto();
      dto.email = "bot@mailinator.com";
      expect(await errorsFor(dto)).toHaveLength(0);
    });

    it("supports per-field block and allow lists", async () => {
      const blocked = new CustomBlockListDto();
      blocked.email = "user@blocked.example";
      expect((await errorsFor(blocked)).length).toBeGreaterThan(0);

      const allowed = new CustomBlockListDto();
      allowed.email = "user@mailinator.com";
      expect(await errorsFor(allowed)).toHaveLength(0);
    });

    it("reads extra blocked domains from DISPOSABLE_EMAIL_DOMAINS", async () => {
      process.env.DISPOSABLE_EMAIL_DOMAINS = " spam.example , Junk.Example ";
      expect((await errorsFor(dtoWith("a@spam.example"))).length).toBeGreaterThan(0);
      expect((await errorsFor(dtoWith("a@junk.example"))).length).toBeGreaterThan(0);
      expect(await errorsFor(dtoWith("a@example.com"))).toHaveLength(0);
    });

    it("honours DISPOSABLE_EMAIL_ALLOWLIST", async () => {
      process.env.DISPOSABLE_EMAIL_ALLOWLIST = "yopmail.com";
      expect(await errorsFor(dtoWith("qa@yopmail.com"))).toHaveLength(0);
    });
  });

  describe("normalizeEmail", () => {
    it.each([
      ["User@Example.COM", "user@example.com"],
      ["  user@example.com  ", "user@example.com"],
      ["John.Doe+newsletter@Gmail.com", "johndoe@gmail.com"],
      ["j.o.h.n.d.o.e@gmail.com", "johndoe@gmail.com"],
      ["johndoe+a+b@gmail.com", "johndoe@gmail.com"],
      ["John.Doe@googlemail.com", "johndoe@gmail.com"],
      // Only Gmail ignores dots and plus tags; other providers keep them.
      ["john.doe+tag@example.com", "john.doe+tag@example.com"],
      ["john.doe+tag@outlook.com", "john.doe+tag@outlook.com"],
    ])("normalizes %s to %s", (input, expected) => {
      expect(normalizeEmail(input)).toBe(expected);
    });

    it("is idempotent", () => {
      const once = normalizeEmail("A.B+c@GoogleMail.com");
      expect(normalizeEmail(once)).toBe(once);
    });

    it("leaves unparseable or non-string input for validation to reject", () => {
      expect(normalizeEmail("plainaddress")).toBe("plainaddress");
      expect(normalizeEmail("+tag@gmail.com")).toBe("+tag@gmail.com");
      expect(normalizeEmail(42)).toBe(42);
      expect(normalizeEmail(undefined)).toBeUndefined();
    });

    it("normalizes via @NormalizeEmail() before validation", async () => {
      const dto = plainToInstance(RegisterLikeDto, {
        email: "  Jane.Doe+Promo@GMAIL.com ",
      });
      expect(dto.email).toBe("janedoe@gmail.com");
      expect(await validate(dto)).toHaveLength(0);
    });

    it("still rejects disposable domains after normalization", async () => {
      const dto = plainToInstance(RegisterLikeDto, { email: "Bot@Mailinator.com" });
      expect(dto.email).toBe("bot@mailinator.com");
      expect((await validate(dto)).length).toBeGreaterThan(0);
    });
  });
});
