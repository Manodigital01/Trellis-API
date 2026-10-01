/**
 * Behaviour of the protocol changelog read model and its HTTP surface.
 *
 * Issue: #126
 */

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { join } from "path";
import { ProtocolChangelogService } from "./protocol-changelog.service";
import { ChangelogController } from "./changelog.controller";

const REPO_ROOT = join(__dirname, "..", "..");

function buildService(changelogPath?: string): ProtocolChangelogService {
  return new ProtocolChangelogService(
    new ConfigService(changelogPath ? { CHANGELOG_PATH: changelogPath } : {}),
  );
}

describe("ProtocolChangelogService", () => {
  describe("query", () => {
    it("returns every entry, newest first, when unfiltered", () => {
      const view = buildService().query();

      expect(view.project).toBe("trellis-api");
      expect(view.schemaVersion).toBe("1.0.0");
      expect(view.entries.length).toBeGreaterThan(0);
      expect(view.latestVersion).toBe("0.2.0");
    });

    it("returns only entries newer than the caller's version", () => {
      const view = buildService().query({ since: "0.1.0" });

      expect(view.entries.length).toBeGreaterThan(0);
      expect(
        view.entries.every((entry) => entry.version === "0.2.0"),
      ).toBe(true);
    });

    it("returns nothing when the caller is already on the newest version", () => {
      const view = buildService().query({ since: "99.0.0" });

      expect(view.entries).toEqual([]);
      expect(view.highestImpact).toBeNull();
      expect(view.migrationRequired).toBe(false);
      expect(view.affectedPaths).toEqual([]);
      expect(view.latestVersion).toBe("0.2.0");
    });

    it("filters by impact", () => {
      const view = buildService().query({ impact: ["breaking"] });

      expect(view.entries.every((entry) => entry.impact === "breaking")).toBe(
        true,
      );
    });

    it("filters by release status", () => {
      const view = buildService().query({ status: "released" });

      expect(view.entries.every((entry) => entry.status === "released")).toBe(
        true,
      );
    });

    it("reports the worst impact and whether the caller must act", () => {
      const view = buildService().query();

      expect(view.highestImpact).toBe("compatible");
      expect(view.migrationRequired).toBe(false);
      expect(view.affectedPaths).toEqual(
        expect.arrayContaining([
          "/changelog/protocol",
          "/health/dependencies",
          "/reconcile/stellar/transactions",
        ]),
      );
    });

    it("flags a migration for a breaking change between the versions", () => {
      const service = buildService(
        join(REPO_ROOT, "changelog/__fixtures__/breaking-entry.json"),
      );
      const view = service.query();

      expect(view.highestImpact).toBe("breaking");
      expect(view.migrationRequired).toBe(true);
      expect(view.entries[0].migration.steps).toEqual([
        "Send ?details=standard to opt into the new response envelope.",
      ]);
    });
  });

  describe("failures", () => {
    it("refuses to serve a changelog that violates the rules", () => {
      const service = buildService(
        join(REPO_ROOT, "changelog/__fixtures__/invalid-entry.json"),
      );

      expect(() => service.getDocument()).toThrow(/is invalid/);
    });

    it("refuses to serve a file that is not JSON", () => {
      const service = buildService(
        join(REPO_ROOT, "changelog/__fixtures__/not-json.json"),
      );

      expect(() => service.getDocument()).toThrow(/is not valid JSON/);
    });

    it("explains that a missing file cannot be read", () => {
      const service = buildService(join(REPO_ROOT, "changelog/nope.json"));

      expect(() => service.getDocument()).toThrow(/Unable to read/);
    });
  });

  describe("getSchema", () => {
    it("serves the JSON Schema that consumers can validate against", () => {
      const schema = buildService().getSchema() as {
        $defs: Record<string, unknown>;
      };

      expect(schema.$defs).toHaveProperty("entry");
      expect(schema.$defs).toHaveProperty("migration");
    });
  });
});

describe("ChangelogController", () => {
  it("returns the changelog for a public caller", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChangelogController],
      providers: [
        ProtocolChangelogService,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();

    const body = moduleRef
      .get(ChangelogController)
      .getProtocolChangelog({ since: "0.1.0" });

    expect(body.schemaVersion).toBe("1.0.0");
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.affectedPaths).toContain("/changelog/protocol");
  });
});
