#!/usr/bin/env ts-node
/**
 * Validates the machine-readable protocol changelog.
 *
 * Runs the same code path the API uses, so a file that passes here cannot fail
 * at runtime. Exits non-zero on any violation, which is what CI keys on.
 *
 * Usage:
 *   npm run changelog:validate
 *   npm run changelog:validate -- --json
 *   npm run changelog:validate -- --file changelog/protocol-changes.json
 *
 * Issue: #126
 */

import {
  loadProtocolChangelog,
  resolveChangelogPath,
  validateProtocolChangelog,
} from "../src/changelog/protocol-changelog.validator";
import { readFileSync } from "fs";

interface Options {
  json: boolean;
  file?: string;
  now?: Date;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--file" || arg === "--path") {
      options.file = argv[index + 1];
      index += 1;
    } else if (arg === "--now") {
      // Deterministic validation in CI and in tests.
      const parsed = new Date(argv[index + 1]);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--now expects an ISO-8601 date, got "${argv[index + 1]}"`);
      }
      options.now = parsed;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.file = undefined;
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Validate changelog/protocol-changes.json against its JSON Schema and the",
      "semantic rules (ordering, traceability, migrations, deprecation windows).",
      "",
      "Options:",
      "  --json           Emit a machine-readable report instead of text.",
      "  --file <path>    Validate a different changelog file.",
      "  --now <iso>      Treat this instant as the current time.",
      "",
    ].join("\n"),
  );
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const path = resolveChangelogPath(options.file);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const message = `Cannot read ${path}: ${(error as Error).message}`;
    process.stderr.write(`${message}\n`);
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    const message = `${path} is not valid JSON: ${(error as Error).message}`;
    process.stderr.write(`${message}\n`);
    return 2;
  }

  const result = validateProtocolChangelog(document, options.now);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: path,
          valid: result.valid,
          violationCount: result.violations.length,
          violations: result.violations,
        },
        null,
        2,
      )}\n`,
    );
    return result.valid ? 0 : 1;
  }

  if (result.valid) {
    // Loading again proves the runtime path agrees with the offline check.
    loadProtocolChangelog({ path, now: options.now });
    const entries = (document as { entries: unknown[] }).entries;
    process.stdout.write(
      `Protocol changelog is valid: ${path} (${entries.length} entries).\n`,
    );
    return 0;
  }

  process.stderr.write(
    `Protocol changelog is invalid: ${path} (${result.violations.length} problems)\n`,
  );
  for (const violation of result.violations) {
    process.stderr.write(
      `  - [${violation.rule}] ${violation.pointer}: ${violation.message}\n`,
    );
  }
  return 1;
}

process.exit(main());
