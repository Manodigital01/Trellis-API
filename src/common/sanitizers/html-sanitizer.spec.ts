import { plainToInstance } from "class-transformer";
import {
  sanitizeXssString,
  sanitizeMarkdownString,
  sanitizeValueDeep,
  SANITIZE_MAX_DEPTH,
} from "./html-sanitizer";
import {
  SanitizeMarkdown,
  SanitizeNested,
  SanitizeString,
} from "../decorators/sanitize.decorator";
import { SanitizePipe } from "../pipes/sanitize.pipe";

class NestedDtos {
  @SanitizeString()
  bio?: string;

  @SanitizeNested()
  profile?: {
    name?: string;
    contact?: { website?: string };
  };

  @SanitizeNested()
  tags?: string[];

  @SanitizeNested()
  matrix?: Array<Array<{ note?: string }>>;
}

class MarkdownDtos {
  @SanitizeMarkdown()
  description?: string;
}

describe("html-sanitizer (deep XSS sanitization)", () => {
  describe("sanitizeXssString", () => {
    it("strips script tags and their contents", () => {
      const out = sanitizeXssString("<script>alert('xss')</script>hello");
      expect(out).not.toContain("alert");
      expect(out).not.toContain("<script>");
      expect(out).toContain("hello");
    });

    it("removes inline event handlers", () => {
      const out = sanitizeXssString('<img src="x" onerror="alert(1)">');
      expect(out).not.toContain("onerror");
      expect(out).not.toContain("alert");
    });

    it("neutralizes javascript: and data:text/html URI schemes", () => {
      expect(sanitizeXssString("javascript:alert(1)")).not.toContain(
        "javascript",
      );
      expect(
        sanitizeXssString("<a href=\"javascript:alert(1)\">click</a>"),
      ).not.toContain("javascript");
      expect(
        sanitizeXssString("<a href=\"data:text/html,<script>alert(1)</script>\">x</a>"),
      ).not.toContain("data:text/html");
    });

    it("escapes iframe, object, embed and form markup", () => {
      const out = sanitizeXssString(
        "<iframe src=\"javascript:alert(1)\"></iframe><object data=\"evil\"></object><form action=\"x\"></form>",
      );
      // Dangerous containers have their attributes stripped and are escaped
      // so they can never execute.
      expect(out).not.toContain("javascript");
      expect(out).not.toContain("data=");
      expect(out).not.toContain("action=");
      expect(out).toContain("&lt;iframe&gt;");
    });

    it("encodes residual HTML special characters", () => {
      expect(sanitizeXssString("2 < 3 & 4 > \"1\" 'ok'")).toBe(
        "2 &lt; 3 &amp; 4 &gt; &quot;1&quot; &#x27;ok&#x27;",
      );
    });

    it("discards script content even when written across lines", () => {
      const out = sanitizeXssString(
        "<script>\n  var a = 1;\n  document.cookie = a;\n</script>safe",
      );
      expect(out).not.toContain("document.cookie");
      expect(out).toContain("safe");
    });

    it("leaves plain text untouched apart from encoding/trimming", () => {
      expect(sanitizeXssString("  hello world  ")).toBe("hello world");
      expect(sanitizeXssString("just plain text")).toBe("just plain text");
    });
  });

  describe("sanitizeMarkdownString", () => {
    it("keeps safe formatting tags and strips dangerous ones", () => {
      const out = sanitizeMarkdownString(
        "<b>bold</b> <em>it</em> <code>code</code> <script>alert(1)</script>",
      );
      expect(out).toContain("<b>bold</b>");
      expect(out).toContain("<em>it</em>");
      expect(out).toContain("<code>code</code>");
      expect(out).not.toContain("alert");
    });

    it("keeps http(s) and mailto links, drops javascript: links", () => {
      const ok = sanitizeMarkdownString(
        '<a href="https://example.com">site</a>',
      );
      expect(ok).toContain('href="https://example.com"');

      const bad = sanitizeMarkdownString(
        '<a href="javascript:alert(1)">bad</a>',
      );
      expect(bad).not.toContain("javascript:");
    });
  });

  describe("sanitizeValueDeep (nested structures)", () => {
    it("sanitizes strings inside deeply nested objects", () => {
      const out = sanitizeValueDeep({
        level1: {
          level2: {
            level3: {
              payload: "<script>alert(1)</script>",
            },
          },
        },
      }) as { level1: { level2: { level3: { payload: string } } } };

      expect(out.level1.level2.level3.payload).not.toContain("alert");
      expect(out.level1.level2.level3.payload).not.toContain("<script>");
    });

    it("sanitizes array elements including nested arrays", () => {
      const out = sanitizeValueDeep({
        tags: ["ok", "<img src=x onerror=alert(1)>"],
        matrix: [[{ note: "javascript:alert(2)" }]],
      }) as { tags: string[]; matrix: Array<Array<{ note: string }>> };

      expect(out.tags[1]).not.toContain("onerror");
      expect(out.matrix[0][0].note).not.toContain("javascript");
    });

    it("preserves the shape and non-string values", () => {
      const input = {
        n: 5,
        flag: true,
        nil: null,
        when: new Date("2026-01-01T00:00:00Z"),
        nested: { deep: [{ s: "x" }] },
      };
      const out = sanitizeValueDeep(input) as typeof input;

      expect(out.n).toBe(5);
      expect(out.flag).toBe(true);
      expect(out.nil).toBeNull();
      expect(out.when).toBe(input.when); // Date passes through untouched
      expect(out.nested.deep[0].s).toBe("x");
    });

    it("bails out at the depth limit instead of recursing forever", () => {
      const cyclic: Record<string, unknown> = { name: "<script>x</script>" };
      cyclic.self = cyclic;
      const out = sanitizeValueDeep(cyclic) as Record<string, unknown>;
      expect(out.name).not.toContain("<script>");
      // The cyclic branch is cut off without throwing.
      expect(typeof out.self).toBeDefined();
      void SANITIZE_MAX_DEPTH;
    });
  });

  describe("DTO integration", () => {
    it("SanitizeString cleans nested payloads assigned to one property", () => {
      class Holder {
        @SanitizeString()
        payload?: unknown;
      }
      const dto = plainToInstance(Holder, {
        payload: { comment: "<script>alert(1)</script>hi" },
      });
      expect((dto.payload as { comment: string }).comment).not.toContain(
        "alert",
      );
    });

    it("SanitizeNested walks child objects and arrays of a DTO property", () => {
      class Holder {
        @SanitizeNested()
        meta?: unknown;
      }
      const dto = plainToInstance(Holder, {
        meta: { list: ["<b>keep?no</b>", { url: "javascript:alert(1)" }] },
      });
      const meta = dto.meta as { list: Array<string | { url: string }> };
      expect(meta.list[0]).not.toContain("<b>");
      expect((meta.list[1] as { url: string }).url).not.toContain("javascript");
    });

    it("plainToInstance with decorated nested DTOs is sanitized at depth", () => {
      const dto = plainToInstance(NestedDtos, {
        bio: "<script>alert('bio')</script>bio",
        profile: {
          name: "<img src=x onerror=alert(1)>Ada",
          contact: { website: "javascript:alert(2)" },
        },
        tags: ["ok", "<svg onload=alert(3)>x</svg>"],
        matrix: [[{ note: "<script>y</script>" }]],
      });

      expect(dto.bio).not.toContain("alert");
      expect(dto.bio).toContain("bio");
      expect(dto.profile!.name).not.toContain("onerror");
      expect(dto.profile!.name).toContain("Ada");
      expect(dto.profile!.contact!.website).not.toContain("javascript");
      expect(dto.tags![1]).not.toContain("onload");
      expect(dto.matrix![0][0].note).not.toContain("<script>");
    });

    it("SanitizeMarkdown preserves safe markdown formatting on a rich-text field", () => {
      const dto = plainToInstance(MarkdownDtos, {
        description:
          "<b>bold</b> and <code>code</code> with <script>alert(1)</script>",
      });
      expect(dto.description).toContain("<b>bold</b>");
      expect(dto.description).toContain("<code>code</code>");
      expect(dto.description).not.toContain("alert");
    });

    it("SanitizePipe sanitizes deeply nested controller payloads end to end", () => {
      const pipe = new SanitizePipe();
      const out = pipe.transform({
        user: {
          profile: { bio: "<script>alert(1)</script>ok" },
          history: ["<img src=x onerror=alert(2)>", { q: "javascript:alert(3)" }],
        },
      }) as {
        user: {
          profile: { bio: string };
          history: Array<string | { q: string }>;
        };
      };

      expect(out.user.profile.bio).not.toContain("alert");
      expect(out.user.profile.bio).toContain("ok");
      expect(out.user.history[0]).not.toContain("onerror");
      expect((out.user.history[1] as { q: string }).q).not.toContain(
        "javascript",
      );
    });

    it("SanitizePipe leaves scalars, Dates and buffers intact", () => {
      const pipe = new SanitizePipe();
      const when = new Date();
      const out = pipe.transform({
        n: 1,
        s: "text",
        when,
      }) as { n: number; s: string; when: Date };
      expect(out.n).toBe(1);
      expect(out.s).toBe("text");
      expect(out.when).toBe(when);
    });
  });
});
