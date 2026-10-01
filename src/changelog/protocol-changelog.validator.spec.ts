/**
 * Contract tests for the machine-readable protocol changelog.
 *
 * The repository file must always validate, and each semantic rule must be
 * proven to reject a document that violates it, because CI and the runtime API
 * both refuse to serve a changelog that fails.
 *
 * Issue: #126
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  loadProtocolChangelog,
  PROTOCOL_CHANGELOG_FILE,
  PROTOCOL_CHANGELOG_SCHEMA_FILE,
  resolveChangelogPath,
  validateProtocolChangelog,
} from "./protocol-changelog.validator";
import type { ProtocolChangelogDocument } from "./protocol-changelog.types";

const REPO_ROOT = join(__dirname, "..", "..");
const NOW = new Date("2026-09-27T12:00:00.000Z");

function shippedDocument(): ProtocolChangelogDocument {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, PROTOCOL_CHANGELOG_FILE), "utf8"),
  );
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.2.0",
    date: "2026-09-27",
    status: "unreleased",
    impact: "compatible",
    title: "A compatible change",
    summary: "Something callers do not have to react to.",
    protocolSurfaces: [
      {
        kind: "http",
        method: "GET",
        path: "/example",
        description: "An example route.",
      },
    ],
    migration: {
      required: false,
      automated: true,
      steps: [],
      notes: "Nothing to do.",
    },
    relatedIssues: [1],
    ...overrides,
  };
}

function documentWith(overrides: Record<string, unknown> = {}) {
  return {
    $schema: "./schema/protocol-changes.schema.json",
    schemaVersion: "1.0.0",
    project: "trellis-api",
    entries: [entry()],
    ...overrides,
  };
}

function rulesFor(document: unknown): string[] {
  return validateProtocolChangelog(document, NOW).violations.map((v) => v.rule);
}

describe("protocol changelog validation", () => {
  describe("the file shipped in this repository", () => {
    it("validates against its own schema and semantic rules", () => {
      const result = validateProtocolChangelog(shippedDocument(), NOW);

      expect(result.violations).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("loads through the runtime path used by the API", () => {
      const loaded = loadProtocolChangelog({ now: NOW });

      expect(loaded.document.project).toBe("trellis-api");
      expect(loaded.document.entries.length).toBeGreaterThan(0);
      expect(loaded.path).toContain(PROTOCOL_CHANGELOG_FILE);
    });

    it("points at the schema that describes it", () => {
      const document = shippedDocument();
      const schema = JSON.parse(
        readFileSync(join(REPO_ROOT, PROTOCOL_CHANGELOG_SCHEMA_FILE), "utf8"),
      );

      expect(document.$schema).toBe("./schema/protocol-changes.schema.json");
      expect(schema.$id).toContain("protocol-changes.schema.json");
      expect(Object.keys(schema.$defs)).toEqual(
        expect.arrayContaining([
          "entry",
          "migration",
          "protocolSurface",
          "deprecation",
        ]),
      );
    });

    it("declares version, date, impact and migration for every entry", () => {
      for (const record of shippedDocument().entries) {
        expect(record.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(record.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(record.impact).toBeTruthy();
        expect(record.migration).toMatchObject({
          required: expect.any(Boolean),
          notes: expect.any(String),
        });
        expect(record.protocolSurfaces.length).toBeGreaterThan(0);
      }
    });

    it("documents the routes and commands this pull request adds", () => {
      const surfaces = shippedDocument().entries.flatMap(
        (record) => record.protocolSurfaces,
      );
      const described = surfaces
        .map((surface) => surface.path ?? surface.key ?? "")
        .join(" ");

      for (const issue of [124, 125, 126, 127]) {
        expect(
          shippedDocument().entries.some((record) =>
            record.relatedIssues?.includes(issue),
          ),
        ).toBe(true);
      }
      expect(described).toContain("/health/dependencies");
      expect(described).toContain("/reconcile/stellar/transactions");
      expect(described).toContain("/changelog/protocol");
      expect(described).toContain("npm run test:faults");
    });
  });

  describe("structural rules", () => {
    it("rejects a missing required field", () => {
      const broken = documentWith();
      delete (broken.entries[0] as Record<string, unknown>).migration;

      expect(rulesFor(broken)).toContain("required");
    });

    it("rejects an unknown field so typos cannot pass silently", () => {
      expect(
        rulesFor(documentWith({ entries: [entry({ notAField: true })] })),
      ).toContain("additionalProperties");
    });

    it("rejects an unrecognised impact value", () => {
      expect(
        rulesFor(documentWith({ entries: [entry({ impact: "sort-of-breaking" })] })),
      ).toContain("enum");
    });

    it("rejects a version that is not semver", () => {
      expect(rulesFor(documentWith({ entries: [entry({ version: "v1" })] }))).toContain(
        "pattern",
      );
    });

    it("rejects a date that is not a real calendar day", () => {
      expect(
        rulesFor(documentWith({ entries: [entry({ date: "2026-02-30" })] })),
      ).toContain("date-not-a-calendar-date");
    });

    it("rejects a date in the future", () => {
      expect(
        rulesFor(documentWith({ entries: [entry({ date: "2027-01-01" })] })),
      ).toContain("date-in-the-future");
    });

    it("rejects an unsupported schema version", () => {
      expect(rulesFor(documentWith({ schemaVersion: "2.0.0" }))).toContain(
        "unsupported-schema-version",
      );
    });
  });

  describe("breaking changes", () => {
    it("rejects a breaking entry without a description of what breaks", () => {
      expect(
        rulesFor(documentWith({ entries: [entry({ impact: "breaking" })] })),
      ).toEqual(
        expect.arrayContaining([
          "breaking-without-description",
          "breaking-without-migration",
        ]),
      );
    });

    it("rejects a breaking entry whose migration is marked optional", () => {
      const breaking = entry({
        impact: "breaking",
        breakingChanges: [
          { description: "The response envelope changed.", replacement: "details" },
        ],
        migration: {
          required: false,
          automated: false,
          steps: [],
          notes: "Callers must adapt.",
        },
      });

      expect(rulesFor(documentWith({ entries: [breaking] }))).toContain(
        "breaking-without-migration",
      );
    });

    it("accepts a breaking entry with a migration plan", () => {
      const breaking = entry({
        impact: "breaking",
        breakingChanges: [
          { description: "The response envelope changed.", replacement: "details" },
        ],
        migration: {
          required: true,
          automated: false,
          steps: ["Send ?details=standard to opt into the new envelope."],
          notes: "The legacy envelope is removed in 1.0.0.",
        },
      });

      expect(validateProtocolChangelog(documentWith({ entries: [breaking] }), NOW)).toEqual(
        { valid: true, violations: [] },
      );
    });

    it("rejects a required migration with no steps", () => {
      const migrated = entry({
        migration: {
          required: true,
          automated: true,
          steps: [],
          notes: "A migration is required.",
        },
      });

      expect(rulesFor(documentWith({ entries: [migrated] }))).toContain(
        "migration-without-steps",
      );
    });

    it("rejects a migration step that is not a complete instruction", () => {
      const migrated = entry({
        migration: {
          required: true,
          automated: false,
          steps: ["run the migration"],
          notes: "A migration is required.",
        },
      });

      expect(rulesFor(documentWith({ entries: [migrated] }))).toContain(
        "migration-step-not-actionable",
      );
    });
  });

  describe("deprecations", () => {
    it("rejects a deprecation with no removal version after the entry", () => {
      const deprecated = entry({
        impact: "deprecation",
        deprecations: [
          { surface: "GET /v1/thing", replacement: "GET /v2/thing", removalVersion: "0.1.0" },
        ],
      });

      expect(rulesFor(documentWith({ entries: [deprecated] }))).toContain(
        "deprecation-removal-not-after-version",
      );
    });

    it("rejects a deprecation listed under a non-deprecation impact", () => {
      const deprecated = entry({
        deprecations: [
          { surface: "GET /v1/thing", replacement: "GET /v2/thing", removalVersion: "1.0.0" },
        ],
      });

      expect(rulesFor(documentWith({ entries: [deprecated] }))).toContain(
        "deprecation-without-impact",
      );
    });

    it("accepts a deprecation with a replacement and a future removal", () => {
      const deprecated = entry({
        impact: "deprecation",
        deprecations: [
          { surface: "GET /v1/thing", replacement: "GET /v2/thing", removalVersion: "1.0.0" },
        ],
      });

      expect(validateProtocolChangelog(documentWith({ entries: [deprecated] }), NOW)).toEqual(
        { valid: true, violations: [] },
      );
    });
  });

  describe("surfaces and traceability", () => {
    it("rejects an http surface with no method", () => {
      expect(
        rulesFor(
          documentWith({
            entries: [
              entry({
                protocolSurfaces: [{ kind: "http", description: "A route." }],
              }),
            ],
          }),
        ),
      ).toContain("http-surface-without-method");
    });

    it("rejects a config surface with no key", () => {
      expect(
        rulesFor(
          documentWith({
            entries: [
              entry({ protocolSurfaces: [{ kind: "config", description: "A key." }] }),
            ],
          }),
        ),
      ).toContain("surface-without-key");
    });

    it("rejects the same surface listed twice in one entry", () => {
      expect(
        rulesFor(
          documentWith({
            entries: [
              entry({
                protocolSurfaces: [
                  { kind: "http", method: "GET", path: "/x", description: "Once." },
                  { kind: "http", method: "GET", path: "/x", description: "Twice." },
                ],
              }),
            ],
          }),
        ),
      ).toContain("duplicate-surface");
    });

    it("rejects an entry that references no issue or pull request", () => {
      expect(
        rulesFor(documentWith({ entries: [entry({ relatedIssues: undefined })] })),
      ).toContain("untraceable-entry");
    });
  });

  describe("ordering", () => {
    it("rejects a copy-pasted entry repeated within one release", () => {
      expect(
        rulesFor(
          documentWith({
            entries: [entry({ title: "Same entry" }), entry({ title: "Same entry" })],
          }),
        ),
      ).toContain("duplicate-entry");
    });

    it("allows several distinct entries in one release", () => {
      const entries = [
        entry({ title: "Dependency health endpoints" }),
        entry({ title: "Transaction detail disclosure" }),
      ];

      expect(validateProtocolChangelog(documentWith({ entries }), NOW).valid).toBe(
        true,
      );
    });

    it("rejects entries that are not ordered newest first", () => {
      const older = entry({ version: "0.1.0", title: "Older entry" });
      const newer = entry({ version: "0.3.0", title: "Newer entry" });

      expect(rulesFor(documentWith({ entries: [older, newer] }))).toContain(
        "entries-out-of-order",
      );
      expect(
        validateProtocolChangelog(documentWith({ entries: [newer, older] }), NOW).valid,
      ).toBe(true);
    });
  });

  describe("load failures", () => {
    it("explains that a missing file is unreadable", () => {
      expect(() =>
        loadProtocolChangelog({ path: join(REPO_ROOT, "changelog/nope.json") }),
      ).toThrow(/Unable to read the protocol changelog/);
    });

    it("explains that a malformed file is not valid JSON", () => {
      const path = join(REPO_ROOT, "changelog/__fixtures__/not-json.json");
      expect(() => loadProtocolChangelog({ path })).toThrow(
        /is not valid JSON/,
      );
    });

    it("reports every violation of an invalid file rather than the first", () => {
      expect(() =>
        loadProtocolChangelog({
          path: join(REPO_ROOT, "changelog/__fixtures__/invalid-entry.json"),
        }),
      ).toThrow(/breaking-without-migration[\s\S]*untraceable-entry/);
    });

    it("resolves an override relative to the repository root", () => {
      expect(
        resolveChangelogPath("changelog/protocol-changes.json", "/repo"),
      ).toBe("/repo/changelog/protocol-changes.json");
      expect(resolveChangelogPath("/abs/file.json", "/repo")).toBe(
        "/abs/file.json",
      );
      expect(resolveChangelogPath(undefined, "/repo")).toBe(
        "/repo/changelog/protocol-changes.json",
      );
    });
  });
});
