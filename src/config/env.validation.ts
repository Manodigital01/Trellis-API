import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsUrl,
  Matches,
  Min,
  Max,
} from "class-validator";
import { Transform } from "class-transformer";

export enum NodeEnv {
  Development = "development",
  Production = "production",
  Test = "test",
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsNumber()
  @Min(1)
  @Max(65535)
  @Transform(({ value }) => parseInt(value, 10) || 3000)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  API_PREFIX: string = "/api/v1";

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** Explicit database identifier override used during the legacy-name compatibility window. */
  @IsOptional()
  @IsString()
  DB_DATABASE?: string;

  @IsString()
  @IsNotEmpty()
  JWT_SECRET: string;

  // RBAC bootstrap: promote the account matching one of these to ADMIN on
  // startup so a fresh deployment has an initial administrator. Optional —
  // when both are unset no seeding occurs. See docs/RBAC.md.
  @IsOptional()
  @IsString()
  ADMIN_BOOTSTRAP_EMAIL?: string;

  @IsOptional()
  @IsString()
  ADMIN_BOOTSTRAP_WALLET?: string;

  @IsString()
  @IsNotEmpty()
  JWT_EXPIRATION: string = "24h";

  // AI Services
  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  @IsOptional()
  @IsString()
  GROK_API_KEY?: string;

  @IsOptional()
  @IsString()
  LLAMA_API_BASE_URL?: string;

  /**
   * Explicit CORS allow-list (issue #83). Comma-separated origins, each a full
   * `scheme://host[:port]` with an optional `*.` subdomain wildcard. The
   * wildcard `*` on its own is rejected at startup in production by
   * `resolveAllowedOrigins()`; this pattern at least rejects malformed entries
   * such as a bare hostname or a value carrying a path.
   */
  @IsOptional()
  @Matches(
    /^$|^([a-z]+:\/\/)(\*\.)?[a-z0-9.-]+(:\d{1,5})?(,([a-z]+:\/\/)(\*\.)?[a-z0-9.-]+(:\d{1,5})?)*$/i,
    {
      message: "CORS_ALLOWED_ORIGINS must be a comma-separated list of origins",
    },
  )
  CORS_ALLOWED_ORIGINS?: string;

  /** Legacy single-list variable, superseded by CORS_ALLOWED_ORIGINS. */
  @IsString()
  @IsNotEmpty()
  @Matches(
    /^([a-z]+:\/\/)(\*\.)?[a-z0-9.-]+(:\d{1,5})?(,([a-z]+:\/\/)(\*\.)?[a-z0-9.-]+(:\d{1,5})?)*$/i,
    { message: "CORS_ORIGIN must be a comma-separated list of origins" },
  )
  CORS_ORIGIN: string = "http://localhost:3001";

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === "true")
  ENABLE_PROFILING?: boolean = false;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 5)
  @Min(1)
  MAX_WS_CONNECTIONS_PER_USER?: number = 5;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value) || 100)
  @Min(0)
  MAX_GAS_FEE_GWEI?: number = 100;

  @IsString()
  LOG_LEVEL: string = "info";

  /** Human-readable service name injected into every structured log record. */
  @IsOptional()
  @IsString()
  SERVICE_NAME?: string = "trellis-api";

  /** Directory for daily-rotating log files. Omit to disable file logging. */
  @IsOptional()
  @IsString()
  LOG_FILE_DIR?: string;

  // CloudWatch logging configuration (all optional)
  @IsOptional()
  @IsString()
  CLOUDWATCH_GROUP_NAME?: string;

  @IsOptional()
  @IsString()
  CLOUDWATCH_STREAM_NAME?: string;

  @IsOptional()
  @IsString()
  CLOUDWATCH_LOG_LEVEL?: string;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 2000)
  CLOUDWATCH_UPLOAD_RATE_MS?: number = 2000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 30)
  CLOUDWATCH_RETENTION_DAYS?: number = 30;

  // Elasticsearch / ELK logging configuration (all optional)
  @IsOptional()
  @IsString()
  ELASTICSEARCH_URL?: string;

  @IsOptional()
  @IsString()
  ELASTICSEARCH_INDEX_PREFIX?: string;

  @IsOptional()
  @IsString()
  ELASTICSEARCH_USERNAME?: string;

  @IsOptional()
  @IsString()
  ELASTICSEARCH_PASSWORD?: string;

  @IsOptional()
  @IsString()
  ELASTICSEARCH_API_KEY?: string;

  @IsOptional()
  @IsString()
  ELASTICSEARCH_CA_CERT?: string;

  @IsOptional()
  @IsString()
  ELASTICSEARCH_LOG_LEVEL?: string;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  @IsOptional()
  @IsString()
  SENTRY_ENVIRONMENT?: string;

  @IsOptional()
  @IsString()
  SENTRY_RELEASE?: string;

  @IsOptional()
  @Transform(({ value }) => parseFloat(value))
  @Min(0)
  @Max(1)
  SENTRY_TRACES_SAMPLE_RATE?: number = 0.1;

  @IsOptional()
  @IsUrl({ require_tld: false })
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  // Observability toggles
  // Master switch for OpenTelemetry tracing. When false the SDK is never
  // started, so there is zero tracing overhead.
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== "false")
  TRACING_ENABLED?: boolean = true;

  // Head-based trace sampling ratio in the range [0, 1]. 1 = sample every
  // trace, 0 = sample none. Keeps tracing overhead bounded in production.
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => (value === undefined ? 1 : parseFloat(value)))
  @Min(0)
  @Max(1)
  OTEL_TRACES_SAMPLER_RATIO?: number = 1;

  // Optional bearer/query token that protects the Prometheus /metrics
  // endpoint. When unset the endpoint is open (fine for private networks
  // and local dev); set it in production so only the scraper can read it.
  @IsOptional()
  @IsString()
  METRICS_AUTH_TOKEN?: string;

  // Monitoring & metrics module configuration (all optional; sane defaults
  // applied in the respective services).
  /** Interval between system CPU/memory/disk samples, in ms. Default 15000. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 15000)
  MONITORING_SYSTEM_INTERVAL_MS?: number;

  /** Mount point / drive to report disk usage for. Default "/" ("C:\\" on Windows). */
  @IsOptional()
  @IsString()
  MONITORING_DISK_MOUNT?: string;

  /** Interval between alert-rule evaluations, in ms. Default 30000. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 30000)
  MONITORING_ALERT_INTERVAL_MS?: number;

  /** Interval between historical metric captures, in ms. Default 15000. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 15000)
  MONITORING_HISTORY_INTERVAL_MS?: number;

  /** Historical metrics retention window, in ms. Default 86400000 (24h). */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 86400000)
  MONITORING_HISTORY_RETENTION_MS?: number;

  /** Max retained historical points (hard memory cap). Default 5760. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 5760)
  MONITORING_HISTORY_MAX_POINTS?: number;

  /** Enable Horizon reconciliation polling. Defaults to false until explicitly enabled. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true")
  RECONCILIATION_HORIZON_POLLING?: boolean = false;

  // Blockchain configuration
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 1)
  CHAIN_ID: number = 1;

  // Blockchain RPC URLs
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ETH_RPC_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ARB_RPC_URL?: string;
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  POLY_RPC_URL?: string;
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  OPT_RPC_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  BSC_RPC_URL?: string;

  // Oracle configuration
  @IsOptional()
  @IsString()
  ORACLE_CONTRACT_ADDRESS?: string;

  @IsOptional()
  @IsString()
  SUBMITTER_PRIVATE_KEY?: string;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 3)
  SUBMITTER_MAX_RETRIES?: number = 3;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 5000)
  SUBMITTER_RETRY_DELAY?: number = 5000;

  // Email configuration
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10) || 587)
  SMTP_PORT?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true")
  SMTP_SECURE?: boolean;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  @IsString()
  EMAIL_VERIFICATION_URL: string = "http://localhost:3000/auth/verify-email";

  @IsString()
  EMAIL_FROM: string = '"Trellis" <noreply@trellis.example>';

  // Redis
  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  /**
   * Comma-separated Redis URLs of independent masters used for Redlock
   * distributed locks (use an odd count, e.g. 3). Falls back to REDIS_URL.
   */
  @IsOptional()
  @IsString()
  REDLOCK_NODES?: string;

  /** Key prefix for distributed locks. Default: "trellis:lock:". */
  @IsOptional()
  @IsString()
  REDLOCK_KEY_PREFIX?: string;

  /** Extra disposable email domains to reject (comma-separated). */
  @IsOptional()
  @IsString()
  DISPOSABLE_EMAIL_DOMAINS?: string;

  /** Domains to exempt from the built-in disposable list (comma-separated). */
  @IsOptional()
  @IsString()
  DISPOSABLE_EMAIL_ALLOWLIST?: string;

  /** Cache version prefix (e.g. "v1", "v2"). Default: "v1". */
  @IsOptional()
  @IsString()
  CACHE_VERSION?: string = "v1";

  /** Default TTL in seconds for cached entries. Default: 300. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 300)
  CACHE_DEFAULT_TTL_SECONDS?: number = 300;

  // Health check timeouts
  @IsOptional()
  @IsNumber()
  @Min(100)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 5000))
  HEALTH_CHECK_TIMEOUT_MS?: number;

  // External dependency health checks (see src/dependency-health)
  /** Set to "false" to turn the dependency health endpoints off entirely. */
  @IsOptional()
  @IsString()
  DEPENDENCY_HEALTH_ENABLED?: string = "true";

  /** Maximum time a single dependency probe may take. Minimum: 100 ms. */
  @IsOptional()
  @IsNumber()
  @Min(100)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 3000))
  DEPENDENCY_HEALTH_TIMEOUT_MS?: number;

  /** Latency above which a reachable dependency is reported as degraded. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1500))
  DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS?: number;

  /** How long a dependency report is reused before probing again. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 15000))
  DEPENDENCY_HEALTH_CACHE_TTL_MS?: number;

  /** Set to "false" to forbid outbound third-party probes even for maintainers. */
  @IsOptional()
  @IsString()
  DEPENDENCY_HEALTH_NETWORK_PROBES?: string = "true";

  // Additional OpenAI Configuration
  @IsOptional()
  @IsString()
  OPENAI_BASE_URL?: string;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 3)
  OPENAI_MAX_RETRIES?: number = 3;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 1000)
  OPENAI_RETRY_DELAY?: number = 1000;

  // Oracle submitter additional configuration
  @IsOptional()
  @Transform(({ value }) => parseFloat(value))
  @Min(1)
  SUBMITTER_GAS_LIMIT_MULTIPLIER?: number = 1.2;

  // Compute Job Queue Configuration
  @IsOptional()
  @IsString()
  COMPUTE_JOB_RETRY_POLICIES?: string;

  // Referral System Configuration
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 10)
  REFERRAL_MAX_PER_USER?: number = 10;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 5)
  REFERRAL_MAX_CLAIMS_PER_IP?: number = 5;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 3)
  REFERRAL_MAX_CLAIMS_PER_DEVICE?: number = 3;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 365)
  REFERRAL_CODE_EXPIRY_DAYS?: number = 365;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 3)
  REFERRAL_SUSPICIOUS_IP_THRESHOLD?: number = 3;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 2)
  REFERRAL_SUSPICIOUS_DEVICE_THRESHOLD?: number = 2;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 3600000)
  REFERRAL_RATE_LIMIT_WINDOW_MS?: number = 3600000;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 10)
  REFERRAL_RATE_LIMIT_MAX_ATTEMPTS?: number = 10;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true")
  REFERRAL_ENABLE_BOT_DETECTION?: boolean = true;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true")
  REFERRAL_ENABLE_VPN_DETECTION?: boolean = false;

  // ── Webhook & Reliable Event Delivery ─────────────────────────────

  /** Default max retries for webhook deliveries. Default 5. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 5)
  WEBHOOK_DEFAULT_MAX_RETRIES?: number = 5;

  /** Default base retry delay in ms. Default 1000. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 1000)
  WEBHOOK_DEFAULT_RETRY_DELAY_MS?: number = 1000;

  /** Default backoff multiplier. Default 2. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value) || 2)
  WEBHOOK_BACKOFF_MULTIPLIER?: number = 2;

  /** Default HTTP request timeout in ms. Default 30000. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 30000)
  WEBHOOK_TIMEOUT_MS?: number = 30000;

  /** Default max deliveries per minute per subscription. Default 10. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 10)
  WEBHOOK_RATE_LIMIT_PER_MINUTE?: number = 10;

  /** Max concurrent delivery workers. Default 5. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 5)
  WEBHOOK_CONCURRENCY?: number = 5;

  // ── File Upload & Storage ──────────────────────────────────────────

  /** Storage backend: local | s3 | azure_blob. Default: local. */
  @IsOptional()
  @IsString()
  FILE_STORAGE_BACKEND?: string = "local";

  /** Max upload size in bytes. Default 52428800 (50MB). */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 52428800)
  FILE_MAX_SIZE_BYTES?: number = 52428800;

  /** Local storage base path. Default: ./uploads */
  @IsOptional()
  @IsString()
  FILE_STORAGE_LOCAL_PATH?: string;

  /** Enable virus scanning. Default true. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== "false")
  FILE_SCAN_ENABLED?: boolean = true;

  /** Enable encryption at rest. Default false. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true")
  FILE_ENCRYPTION_ENABLED?: boolean = false;

  /** Enable scheduled cleanup. Default true. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== "false")
  FILE_CLEANUP_ENABLED?: boolean = true;

  /** Days before orphaned files are deleted. Default 7. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 7)
  FILE_ORPHAN_RETENTION_DAYS?: number = 7;

  /** Days before expired files are deleted. Default 1. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 1)
  FILE_EXPIRED_RETENTION_DAYS?: number = 1;

  /** Default file expiry in hours. Default 720 (30 days). */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 720)
  FILE_DEFAULT_EXPIRY_HOURS?: number = 720;

  // S3 Configuration
  @IsOptional()
  @IsString()
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  S3_REGION?: string;

  @IsOptional()
  @IsString()
  S3_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  S3_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true")
  S3_FORCE_PATH_STYLE?: boolean = false;

  // Azure Blob Storage Configuration
  @IsOptional()
  @IsString()
  AZURE_STORAGE_CONNECTION_STRING?: string;

  @IsOptional()
  @IsString()
  AZURE_STORAGE_CONTAINER?: string;

  /** Redis host for webhook Bull queue (falls back to REDIS_HOST). */
  @IsOptional()
  @IsString()
  REDIS_HOST?: string;

  /** Redis port for webhook Bull queue (falls back to 6379). */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 6379)
  REDIS_PORT?: number;

  /** Redis password for webhook Bull queue. */
  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  // ── Payment Processors (plugin system) ─────────────────────────────

  /** Default processor when no `X-Payment-Processor` header is supplied, e.g. "stellar". */
  @IsOptional()
  @IsString()
  PAYMENTS_DEFAULT_PROCESSOR?: string;

  /** Stripe signing secret (`whsec_...`) for /payments/webhooks/stripe. */
  @IsOptional()
  @IsString()
  STRIPE_WEBHOOK_SECRET?: string;

  /** Coinbase Commerce shared secret for /payments/webhooks/coinbase. */
  @IsOptional()
  @IsString()
  COINBASE_WEBHOOK_SECRET?: string;

  /** Shared secret for the generic HMAC scheme (/payments/webhooks/generic). */
  @IsOptional()
  @IsString()
  PAYMENTS_WEBHOOK_SECRET?: string;

  /** Accepted clock skew, in seconds, for signed webhook timestamps. */
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10) || 300)
  PAYMENTS_WEBHOOK_TOLERANCE_SECONDS?: number = 300;

  /** Stellar Horizon endpoint. Default: https://horizon-testnet.stellar.org */
  @IsOptional()
  @IsString()
  STELLAR_HORIZON_URL?: string;

  /**
   * Comma-separated fallback Horizon endpoints (issue #160), tried in order
   * when the primary fails or exceeds the timeout. Example:
   * "https://horizon-fallback.stellar.example,https://horizon.example.org".
   */
  @IsOptional()
  @IsString()
  STELLAR_HORIZON_FALLBACK_URLS?: string;

  /** Per-attempt Horizon request timeout in ms. Default: 5000 (issue #160). */
  @IsOptional()
  @IsNumber()
  @Min(100)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 5000))
  STELLAR_HORIZON_TIMEOUT_MS?: number = 5000;

  /** Max attempts (retries + failover) per Horizon request. Default: 2. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 2))
  STELLAR_HORIZON_MAX_RETRIES?: number = 2;

  /** Base delay in ms for exponential backoff between attempts. Default: 100. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) =>
    value !== undefined && value !== "" ? parseInt(value, 10) : 100,
  )
  STELLAR_HORIZON_BACKOFF_BASE_MS?: number = 100;

  /** How long a failed Horizon node is skipped before being retried, in ms. Default: 60000. */
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Transform(({ value }) => (value ? parseInt(value, 10) : 60000))
  STELLAR_HORIZON_HEALTH_TTL_MS?: number = 60000;

  /** Stellar network passphrase. Default: testnet passphrase. */
  @IsOptional()
  @IsString()
  STELLAR_NETWORK_PASSPHRASE?: string;

  /** Secret seed the server signs Stellar transactions/refunds with. */
  @IsOptional()
  @IsString()
  STELLAR_SIGNING_SECRET?: string;

  /** Base URL of the Grantfox REST gateway. */
  @IsOptional()
  @IsString()
  GRANTFOX_API_URL?: string;

  /** Bearer API key for the Grantfox gateway. */
  @IsOptional()
  @IsString()
  GRANTFOX_API_KEY?: string;

  // Grantfox OAuth2 SSO (PKCE flow)
  @IsOptional()
  @IsString()
  GRANTFOX_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GRANTFOX_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  GRANTFOX_AUTHORIZATION_URL?: string;

  @IsOptional()
  @IsString()
  GRANTFOX_TOKEN_URL?: string;

  @IsOptional()
  @IsString()
  GRANTFOX_USERINFO_URL?: string;

  @IsOptional()
  @IsString()
  GRANTFOX_REVOKE_URL?: string;

  @IsOptional()
  @IsString()
  GRANTFOX_REDIRECT_URI?: string;

  /** 32-byte hex key for AES-256-GCM encryption of refresh tokens at rest. */
  @IsOptional()
  @IsString()
  GRANTFOX_ENCRYPTION_KEY?: string;
  // Rate Limiting & Abuse Protection (distributed, Redis-backed)

  /** Redis key prefix for rate-limit entries. Default: "trellis:rl:". */
  @IsOptional()
  @IsString()
  RATE_LIMIT_REDIS_KEY_PREFIX?: string = "trellis:rl:";

  /**
   * Default rate-limiting strategy: "token-bucket" (default) or
   * "sliding-window".
   */
  @IsOptional()
  @IsString()
  RATE_LIMIT_DEFAULT_STRATEGY?: string = "token-bucket";

  /**
   * When "false", the rate limiter will reject requests (rather than fall back
   * to in-memory) if Redis is unavailable. Default: true.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== "false")
  RATE_LIMIT_FALLBACK_TO_MEMORY?: boolean = true;

  // ── Integration Sandbox Mode ───────────────────────────────────────
  // Opt-in deterministic fakes for the external payment/chain dependency so
  // contributors can run the primary payment workflow with no credentials.
  // Refused when NODE_ENV=production (see src/sandbox/sandbox.config.ts).

  /** Master switch for sandbox mode. Must be exactly "true". Default: false. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true" || value === true)
  SANDBOX_MODE?: boolean = false;

  /** Default sandbox scenario: success | payment_failed | insufficient_funds | horizon_timeout. */
  @IsOptional()
  @IsString()
  SANDBOX_SCENARIO?: string = "success";

  /** Seed for deterministic sandbox ids/hashes. Changing it changes every id. */
  @IsOptional()
  @IsString()
  SANDBOX_SEED?: string = "trellis-local-sandbox";

  // ── Trading policy ─────────────────────────────────────────────────

  /** Master switch for the trade execution endpoint. Default: true. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== "false")
  TRADING_ENABLED?: boolean = true;

  /** Maximum amount accepted by a single trade request. Default: 100000. */
  @IsOptional()
  @IsNumber()
  @Min(Number.EPSILON)
  @Transform(({ value }) => parseFloat(value) || 100000)
  TRADING_MAX_ORDER_AMOUNT?: number = 100000;

  /** Optional comma-separated asset allow-list, e.g. "XLM,USDC". */
  @IsOptional()
  @IsString()
  TRADING_ALLOWED_ASSETS?: string;

  /** Comma-separated trade sides. Defaults to "buy,sell". */
  @IsOptional()
  @IsString()
  TRADING_ALLOWED_SIDES?: string;
}
