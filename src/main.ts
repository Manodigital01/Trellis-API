import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { AppModule } from "./app.module";
import * as helmet from "helmet";
import { ConfigService } from "@nestjs/config";
import { logger } from "./config/logger";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { SanitizePipe } from "./common/pipes/sanitize.pipe";
import { createGlobalValidationPipe } from "./common/pipes/validation.pipe";
import { createCorsConfig } from "./config/cors.config";
import { createHelmetConfig } from "./config/helmet.config";
import { setupSwagger } from "./config/swagger.config";
import * as Sentry from "@sentry/node";
import { expressIntegration } from "@sentry/node";
import { initSentry } from "./config/sentry";
import { sentryBreadcrumbMiddleware } from "./common/middleware/sentry.middleware";
import { assertSecretsValid } from "./config/secrets-validation";
import { AccessibilityMiddleware } from "./common/middleware/accessibility.middleware";

async function bootstrap() {
  // Validate secrets before any other initialisation so misconfigured
  // deployments fail fast with actionable error messages rather than
  // confusing runtime errors deep in the stack.
  assertSecretsValid(process.env as Record<string, string | undefined>, {
    warn: (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
  });

  initSentry();

  // Initialize tracing safely
  try {
    const { startTracing } = await import("./config/tracing");
    await startTracing();
    logger.info("Tracing initialized");
  } catch (error) {
    logger.warn({ error: error.message }, "Tracing skipped");
  }

  // Create app with error handling to catch database issues early
  let app;
  try {
    // Create app - we can't use ConfigService in the logger config yet because app isn't fully initialized
    app = await NestFactory.create(AppModule, {
      logger: ["log", "error", "warn", "debug", "verbose"],
    });
  } catch (createAppError) {
    logger.error(
      { error: createAppError },
      "Failed to initialize application (likely database connection error)",
    );
    // Create a minimal app to still serve Swagger if possible
    app = await NestFactory.create(AppModule, {
      logger: ["log", "error", "warn"],
      abortOnError: false,
    });
  }

  const configService = app.get(ConfigService);
  // Override logger level after app is initialized based on environment
  if (configService.get("NODE_ENV") === "production") {
    app.useLogger(["error", "warn"]);
  }

  // Initialize Sentry request and performance monitoring middleware
  // For Sentry v8+, expressIntegration automatically handles middleware when added to integrations
  app.use(sentryBreadcrumbMiddleware);

  // Security Headers - Helmet
  app.use(helmet.default(createHelmetConfig()));

  // Handle favicon requests to prevent 404 errors in logs
  app.use((req: any, res: any, next: any) => {
    if (req.url === "/favicon.ico") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Global configuration
  app.setGlobalPrefix("api/v1");
  // URI-based versioning (e.g. /api/v1/... and /api/v2/...).
  // The global prefix remains "api" while version segments appear per-route.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: "1",
  });
  app.useGlobalPipes(
    // Sanitize first to strip XSS payloads before validation
    new SanitizePipe(),
    createGlobalValidationPipe(),
  );

  // Accessibility middleware
  app.use(AccessibilityMiddleware);

  // CORS configuration with stricter settings
  app.enableCors(createCorsConfig(configService));

  // Disable x-powered-by header
  app.getHttpAdapter().getInstance().disable("x-powered-by");

  // Swagger/OpenAPI Documentation Setup - Set this up BEFORE trying to listen, so it works even if DB fails
  setupSwagger(app);

  const port = parseInt(process.env.PORT || "3001"); // Get port from environment variable, fallback to 3001 to match .env default

  // Try to start the server, but handle database connection errors gracefully
  try {
    await app.listen(port);
    logger.info(`🚀 Application running on http://localhost:${port}/api/v1`);
    logger.info(
      `📚 API Documentation available at http://localhost:${port}/api/docs`,
    );
    logger.info(
      `🔌 WebSocket endpoint available at ws://localhost:${port}/api/v1/dashboard`,
    );
  } catch (listenError) {
    logger.error(
      { error: listenError, stack: listenError.stack },
      "First listen attempt failed (full error details)",
    );
    logger.error(
      { error: listenError },
      "Failed to start server completely, but Swagger UI is still available",
    );
    // Still try to start the server on a basic level to serve Swagger
    await app.listen(port);
    logger.info(`🚀 Application running on http://localhost:${port}/api/v1`);
    logger.info(
      `📚 Swagger UI successfully available at http://localhost:${port}/api/docs`,
    );
    logger.info(
      `🔌 WebSocket endpoint available at ws://localhost:${port}/api/v1/dashboard`,
    );
  }
}

bootstrap().catch((error) => {
  logger.error({ error }, "Bootstrap failed");
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  if (Sentry.getCurrentHub().getClient()) {
    Sentry.captureException(error);
    Sentry.flush(2000).finally(() => {
      logger.error({ error }, "Uncaught Exception");
      process.exit(1);
    });
    return;
  }

  logger.error({ error }, "Uncaught Exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  console.error("=== UNHANDLED REJECTION RAW REASON ===");
  console.error(reason);
  console.error("=== FULL ERROR OBJECT ===");
  if (reason instanceof Error) {
    console.error("Error message:", reason.message);
    console.error("Error stack:", reason.stack);
  }

  const error = reason instanceof Error ? reason : new Error(String(reason));

  if (Sentry.getCurrentHub().getClient()) {
    Sentry.captureException(error);
    Sentry.flush(2000).finally(() => {
      logger.error({ error, stack: error.stack }, "Unhandled Rejection");
      process.exit(1);
    });
    return;
  }

  logger.error({ error, stack: error.stack }, "Unhandled Rejection");
  process.exit(1);
});
