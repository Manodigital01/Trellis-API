# Machine-readable protocol changelog

Issue: [#126](https://github.com/TRELLIS-STELLAR/Trellis-API/issues/126)

`CHANGELOG.md` is written for people reading a release note. This is the
machine-readable counterpart: every change to a route, a WebSocket or GraphQL
surface, a configuration key or an operator command, with its impact on existing
callers and the migration that applies.

## Files

| Path | Purpose |
| --- | --- |
| `changelog/protocol-changes.json` | The changelog itself. |
| `changelog/schema/protocol-changes.schema.json` | JSON Schema (draft 2020-12) for the file. |
| `changelog/__fixtures__/` | Deliberately invalid files used by the tests. |
| `src/changelog/` | Validator, read model and HTTP endpoint. |
| `scripts/validate-protocol-changelog.ts` | Command-line validation. |

## Using it

```bash
curl "$API/changelog/protocol"

# What would an upgrade from the version I run do to me?
curl "$API/changelog/protocol?since=0.1.0"

# Only the entries that could break me.
curl "$API/changelog/protocol?impact=breaking&impact=deprecation"
```

The response adds what a caller needs to decide:

```json
{
  "schemaVersion": "1.0.0",
  "project": "trellis-api",
  "latestVersion": "0.2.0",
  "highestImpact": "compatible",
  "migrationRequired": false,
  "affectedPaths": ["/changelog/protocol", "/health/dependencies"],
  "entries": [ ... ]
}
```

`migrationRequired` is true when at least one matching entry is breaking or
declares a required migration, so a caller can branch on one boolean.

## Entry shape

```json
{
  "version": "0.3.0",
  "date": "2026-09-27",
  "status": "unreleased",
  "impact": "breaking",
  "title": "Response envelope replaced by the disclosure block",
  "summary": "Every reconciliation response is wrapped in a disclosure envelope.",
  "protocolSurfaces": [
    {
      "kind": "http",
      "method": "GET",
      "path": "/reconcile/stellar/tx/{txid}",
      "description": "The transaction payload moves under data."
    }
  ],
  "migration": {
    "required": true,
    "automated": false,
    "steps": ["Send ?details=standard to opt into the new response envelope."],
    "notes": "The legacy envelope is removed in 1.0.0."
  },
  "breakingChanges": [
    {
      "description": "The transaction payload moved under data.",
      "replacement": "Read data.transaction instead of the top-level payload.",
      "issue": 125
    }
  ],
  "relatedIssues": [125]
}
```

- `impact`: `breaking`, `deprecation`, `compatible`, `fix` or `security`. It is
  the worst case for a caller that does nothing.
- `status`: `unreleased` marks merged work that is not cut as a release yet.
- `migration.automated` says whether tooling applies the migration or a human
  does.
- `protocolSurfaces` uses `path` for `http`/`websocket`/`graphql`/`cli` and `key`
  for `config`.

## Validation

The schema covers structure; a second layer covers the rules a schema cannot
express. Both run in CI and locally, and both are required to pass before the
API will serve the file.

```bash
npm run changelog:validate
npm run changelog:validate -- --json
npm run changelog:validate -- --file path/to/other.json
npm run changelog:validate -- --now 2026-09-27T00:00:00Z   # deterministic
```

| Rule | Why |
| --- | --- |
| `required`, `enum`, `pattern`, `additionalProperties` | Missing fields, bad values and typos fail instead of being ignored. |
| `date-not-a-calendar-date`, `date-in-the-future` | A typo such as `2026-02-30` or a date ahead of today is rejected. |
| `breaking-without-description` | A breaking entry must say what breaks. |
| `breaking-without-migration` | A breaking entry must set `migration.required`. |
| `migration-without-steps` | A required migration must list steps. |
| `migration-step-not-actionable` | A step must be a complete, imperative sentence. |
| `deprecation-without-impact` | Deprecations imply `impact: deprecation` or `breaking`. |
| `deprecation-removal-not-after-version` | A deprecation needs a removal version later than its own. |
| `surface-without-path`, `surface-without-key`, `http-surface-without-method` | A surface must identify what it changes. |
| `duplicate-surface` | The same surface is listed once per entry. |
| `untraceable-entry` | Every entry references an issue or a pull request. |
| `duplicate-entry` | A copy-pasted entry within one release is rejected. |
| `entries-out-of-order` | Entries are ordered newest first. |
| `unsupported-schema-version` | The file matches the schema this build understands. |

Validation runs with an injected clock, so `--now` makes a run reproducible
instead of failing the day after a release is dated.

## Adding an entry

1. Add an object to `changelog/protocol-changes.json`, newest version first,
   with `relatedIssues` filled in.
2. Run `npm run changelog:validate`.
3. The endpoint picks it up on the next deploy; there is no generation step.
