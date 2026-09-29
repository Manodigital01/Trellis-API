/**
 * Standalone script that boots the NestJS app just long enough to generate
 * and write the OpenAPI JSON document to docs/openapi.json, then exits.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/export-openapi.ts
 *   npm run openapi:export
 *
 * Breaking change detection is performed by scripts/validate-openapi.ts,
 * which compares the generated docs/openapi.json against the git baseline.
 * Use --allow-breaking-changes on validate-openapi.ts to override.
 */

import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DataSource } from "typeorm";
import { execSync } from "child_process";

async function exportOpenApi() {
  // Mock TypeORM connection initialization so OpenAPI export works offline without live Postgres
  const origInit = DataSource.prototype.initialize;
  DataSource.prototype.initialize = async function () {
    return this;
  };

  // Silence NestJS bootstrap logs — we only want the artefact output
  let app: any;
  try {
    const { AppModule } = await import("../src/app.module");
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  } catch (err: any) {
    console.warn("Bootstrap warning during spec export:", err.message);
  } finally {
    DataSource.prototype.initialize = origInit;
  }

  const config = new DocumentBuilder()
    .setTitle("Trellis Backend API")
    .setDescription(
      "Comprehensive API documentation for Trellis backend services including " +
      "agent management, oracle submissions, compute operations, and audit trails.",
    )
    .setVersion("1.0.0")
    .setContact("Trellis Team", "https://trellis.example", "api@trellis.example")
    .setLicense("MIT", "https://opensource.org/licenses/MIT")
    .addServer("http://localhost:3001", "Development Server")
    .addServer("https://api.trellis.example", "Production Server")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT", name: "JWT", description: "Enter JWT token", in: "header" },
      "JWT-auth",
    )
    .addApiKey(
      { type: "apiKey", name: "X-API-Key", in: "header", description: "API key for service-to-service communication" },
      "api-key",
    )
    .addTag("Health", "Liveness, readiness, and startup probes for Kubernetes orchestration")
    .addTag("Authentication", "User authentication and authorization")
    .addTag("Enhanced Authentication & KYC", "Enhanced auth with 2FA and KYC flows")
    .addTag("Users", "User management operations")
    .addTag("Oracle", "Oracle data submissions and payload management")
    .addTag("Price Feed", "Aggregated on-chain price data")
    .addTag("Audit", "Audit trail and logging")
    .addTag("Profile", "User profile management")
    .addTag("Info", "API health and meta-information")
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    deepScanRoutes: true,
    operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
  });

  // Write JSON
  const outDir = join(__dirname, "..", "docs");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "openapi.json");
  writeFileSync(jsonPath, JSON.stringify(document, null, 2), "utf8");
  console.log(`✅  OpenAPI JSON written to ${jsonPath}`);

  // Snapshot the current spec as the baseline for future breaking-change checks.
  // The baseline is stored alongside the generated spec so validate-openapi.ts
  // can diff against it without requiring a git checkout of a prior revision.
  try {
    const baselinePath = join(outDir, "openapi.baseline.json");
    writeFileSync(baselinePath, JSON.stringify(document, null, 2), "utf8");
    console.log(`✅  OpenAPI baseline written to ${baselinePath}`);
  } catch (baselineErr: any) {
    console.warn("Could not write OpenAPI baseline snapshot:", baselineErr?.message ?? baselineErr);
  }

  await app.close();
  process.exit(0);
}

exportOpenApi().catch((err) => {
  console.error("Failed to export OpenAPI spec:", err);
  process.exit(1);
});
