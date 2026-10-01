<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/trellis-lockup-dark.png">
    <img src="docs/brand/trellis-lockup.png" alt="Trellis" width="331">
  </picture>
</p>

<h1 align="center">Trellis API</h1>

<p align="center">
  <strong>Off-chain services and API layer for Trellis &mdash; secure, auditable,<br>real-time backend services that complement the on-chain logic.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-1C6B55?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/NestJS-11-14201C?style=flat-square" alt="NestJS">
  <img src="https://img.shields.io/badge/TypeScript-5.3%2B-1C6B55?style=flat-square" alt="TypeScript">
  <img src="https://img.shields.io/badge/Stellar-blockchain-14201C?style=flat-square" alt="Stellar">
  <img src="https://img.shields.io/badge/status-active%20development-E39A3C?style=flat-square" alt="Status">
</p>

---

A robust NestJS-based off-chain services suite and API layer that powers Trellis: secure, auditable, real-time backend services that complement on‑chain logic. Implemented with NestJS (Node.js + TypeScript) with optional Rust adapters for performance‑critical components.

## Purpose

Provide the off‑chain infrastructure required for agents, oracles, and operators to interact reliably with the Trellis blockchain ecosystem. This backend ensures off‑chain computation, telemetry, and decisioning are secure, verifiable, and low‑latency.

## Core responsibilities

- AI compute bridge
  Orchestrate calls to external AI providers (OpenAI, Grok, Llama, etc.) when an agent "thinks". Validate and normalize results, produce auditable outcomes, and submit verifiable results on‑chain.

- Real‑time agent dashboard
  WebSocket gateways and event streams for live agent status, progress updates, heartbeats, and telemetry used by dashboards and operator UIs.

- User authentication
  Wallet signature authentication as the primary flow, with optional email linking and recovery. Traditional email/password authentication with secure bcrypt hashing. Implemented with Nest guards and strategies.

- Agent discovery & recommendation engine
  Index agent metadata, capabilities, provenance, and historical performance. Provide discovery endpoints and personalized recommendation/ranking APIs.

- Price oracles & simulated environments
  Provide price feeds and configurable simulation environments for safe, repeatable agent testing and rehearsal.

## Design principles

- Clear guarantees — Strict boundaries between off‑chain computation and on‑chain commitments; critical outcomes are signed and auditable.
- Real‑time first — Low‑latency WebSocket and event‑driven interfaces for monitoring agents and operator feedback.
- Developer friendly — Modular NestJS architecture, typed APIs, clear contracts, and adapters for new AI providers or oracles.
- Secure by default — Wallet‑based auth flows, least privilege for service accounts, rigorous input validation, and rate limiting.
- Observable & auditable — Structured logs, metrics, traces, and persistent event history for debugging and compliance.

### Signed Oracle payloads

Oracle payloads are serialized as canonical JSON before hashing, EIP-712 signing, and contract submission. Object keys are sorted recursively, JSON whitespace is omitted, and negative zero is normalized to zero. Non-finite numbers, unsafe integer values, undefined values, and non-plain objects are rejected; encode large integer amounts as decimal strings. Payload type values are trimmed and lowercased. Property names and string values keep their original casing and whitespace. Verification attempts the legacy insertion-order representation for older signatures when the original property order is available; new payloads always use canonical serialization.

## High‑level architecture (NestJS mapping)

- NestJS Modules — Logical separation: ComputeBridgeModule, DashboardModule, AuthModule, IndexerModule, OracleModule, SimulatorModule, SubmitterModule.
- Controllers (REST) — Management, configuration, and historical queries.
- WebSocket Gateways — Live events, heartbeats, push notifications to clients (NestJS Gateway).
- Services / Providers — Business logic, provider adapters (OpenAI/Grok/Llama), indexing, on‑chain submitter.
- Guards / Strategies — Wallet signature verification, session/role guards.
- Pipes / Interceptors — Validation, transformation, and observability (request timing, tracing).
- Repositories / Entities — DB models (TypeORM or Prisma) for events, indexes, and audit logs.
- Background workers — Queues (BullMQ / Redis) for batching, retrying, and scheduled tasks.
- Observability — Logging, metrics, and tracing (OpenTelemetry, Prometheus, Grafana).

## SDK & Client Libraries

Auto-generated, type-safe SDKs are available for TypeScript and Python:

- **API Reference**: Browsable Redoc reference published at [https://trellis-stellar.github.io/Trellis-API/](https://trellis-stellar.github.io/Trellis-API/) — no clone required
- **Raw OpenAPI Spec**: Fetchable at [https://trellis-stellar.github.io/Trellis-API/openapi.json](https://trellis-stellar.github.io/Trellis-API/openapi.json)
- **TypeScript Client**: Full-featured ESM + CommonJS client with complete type safety
- **Python Client**: Full-featured async-capable client with type hints

All SDKs are auto-generated from the authoritative OpenAPI v3 specification. The API reference and raw spec are rebuilt and published to GitHub Pages on every merge to `main`; the generated TypeScript/Python client packages remain available as CI artifacts.

**Quick SDK Usage:**

```typescript
// TypeScript
import { Configuration, PortfolioApi } from "@trellis/api-client";

const config = new Configuration({
  basePath: "https://api.trellis.example",
  accessToken: process.env.JWT_TOKEN,
});

const api = new PortfolioApi(config);
const portfolios = await api.portfolioPortfoliosGet({ page: 1, pageSize: 10 });
```

```python
# Python
import trellis_api
from trellis_api.apis import PortfolioApi

config = trellis_api.Configuration(
    host="https://api.trellis.example",
    access_token=os.getenv("JWT_TOKEN"),
)

api_client = trellis_api.ApiClient(config)
portfolio_api = PortfolioApi(api_client)
portfolios = portfolio_api.portfolio_portfolios_get(page=1, page_size=10)
```

See examples for complete integration patterns.

## Technical highlights

- Primary stack: NestJS (Node.js + TypeScript). Optional Rust for compute‑intensive adapters.
- API patterns: REST controllers for management and history; WebSocket Gateways for live events.
- Provider adapters: Pluggable architecture for OpenAI / Grok / Llama and other LLM/agent providers.
- Security: Signed, auditable submissions; wallet auth flows; service account isolation.
- Dev ergonomics: Typed DTOs, validation (class‑validator), sample scripts, and a local simulation mode.

## Quick start (developer)

1. Clone the repo
   git clone https://github.com/TRELLIS-STELLAR/Trellis-API.git

2. Install dependencies
   npm install

3. Configure environment
   Copy `.env.example` → `.env` and populate provider keys, wallet credentials, DB connection, and runtime flags.

   **⚠️ SECURITY:** Never commit `.env` files. Use `.env.example` for templates only.

4. Run locally (development)
   npm run start:dev
   - Uses Nest's hot reload; gateways and controllers available at configured ports.

5. Build & run production
   npm run build
   npm run start:prod

## Docker (optimized multi-stage image)

- Build the production image (uses cached dependency layer when package.json unchanged):

  ```bash
  DOCKER_BUILDKIT=1 docker build --target runner -t stellai-backend:latest .
  ```

- Run locally from the built image:

  ```bash
  docker run --rm -p 3000:3000 -e NODE_ENV=production stellai-backend:latest
  ```

- Or use the included production compose service (no source mounts):
  ```bash
  docker compose up --build app_prod
  ```

Notes:

- The Dockerfile uses a multi-stage build to cache dependencies and copy only `dist` + production `node_modules` into the final image.
- To speed up CI, enable BuildKit (`DOCKER_BUILDKIT=1`) so layer caching and mount caching work well.

6. Useful commands
   - Nest CLI: `npx nest start` / `npx nest build`
   - Lint: `npm run lint`
   - Tests: `npm run test` / `npm run test:watch`
   - Simulate: `npm run simulate` (local replay & sandbox mode)
   - Security audit: `npm audit`

## Security

**🔒 Security is a top priority for trellis.**

### Security Features

- ✅ Helmet security headers
- ✅ Rate limiting (100 req/min per IP)
- ✅ JWT authentication with wallet signature verification
- ✅ Input validation on all endpoints
- ✅ CORS whitelist configuration

### For Production Deployments

1. Generate secrets: `npm run security:generate-secrets`
2. Complete audit: Review `SECURITY_AUDIT.md`
3. Enable monitoring and alerts

### Reporting Security Issues

**DO NOT** create public issues for vulnerabilities.
Email: **security@trellis.example**

See [SECURITY.md](SECURITY.md) for vulnerability reporting details.

### Security Documentation

- 🔐 [SECURITY.md](SECURITY.md) - Vulnerability reporting policy
- 📋 [SECURITY_AUDIT.md](SECURITY_AUDIT.md) - Pre-production checklist & threat model
- 🛡️ [docs/RBAC.md](docs/RBAC.md) - Role-based access control: roles, guard, token-claim mapping & admin setup

## API Endpoints

### GraphQL Gateway

The authenticated GraphQL endpoint is `POST /api/v1/graphql`. It provides
typed, cursor-paginated approved agent reviews and rating summaries without
replacing the existing REST endpoints. See
[GraphQL Gateway](docs/GRAPHQL_GATEWAY.md) for the schema, pagination contract,
type generation, and typed client example.

### Authentication

The backend supports two authentication methods:

#### Traditional Email/Password Authentication

- `POST /auth/register` - Register a new user with email, password, and optional username
- `POST /auth/login` - Login with email and password, returns JWT token
- `POST /auth/logout` - Logout (client-side token removal)
- `GET /auth/status` - Check authentication status (requires JWT token)

#### Wallet-Based Authentication

- `POST /auth/challenge` - Request a signing challenge for wallet authentication
- `POST /auth/verify` - Verify wallet signature and issue JWT token
- Additional endpoints for email linking, recovery, and wallet management

All authentication endpoints use JWT tokens for session management with bcrypt password hashing for traditional auth.

### Job Control API

Fine-grained control over compute jobs with role-based access control:

- `GET /queue/jobs/:id/status` - Get detailed job status (authenticated users)
- `POST /queue/jobs/:id/pause` - Pause a queued job (operators/admins only)
- `POST /queue/jobs/:id/resume` - Resume a paused job (operators/admins only)
- `POST /queue/jobs/:id/cancel` - Cancel a job (operators/admins only)

**Features:**

- Real-time job state monitoring with progress tracking
- Pause/resume capabilities for queued and delayed jobs
- Safe cancellation with state validation
- Role-based authorization (operator/admin required for control operations)
- Comprehensive error handling and validation

**Documentation:**

- 📖 [Job Control API Documentation](docs/JOB_CONTROL_API.md) - Complete API reference
- 🚀 [Quick Start Guide](docs/JOB_CONTROL_QUICK_START.md) - Get started in 5 minutes

**Use Cases:**

- Pause jobs during maintenance windows
- Cancel long-running or stuck jobs
- Monitor job progress in real-time
- Implement custom job orchestration workflows

### Background Workers

Delayed and retryable background jobs are managed via BullMQ:

- `POST /api/v1/workers/jobs` - Enqueue a background job
- `GET /api/v1/workers/jobs/:id` - Get job details by ID
- `GET /api/v1/workers/jobs` - List jobs with optional status filter
- `POST /api/v1/workers/jobs/:id/retry` - Retry a failed or dead-lettered job
- `POST /api/v1/workers/jobs/:id/cancel` - Cancel a pending or active job
- `GET /api/v1/workers/metrics` - Get worker metrics and job statistics

**Local development:**

```bash
# Start Redis (required for BullMQ)
docker run -d -p 6379:6379 redis:alpine

# Start the application (workers start automatically)
npm run start:dev
```

**Enqueuing a job:**

```typescript
POST /api/v1/workers/jobs
{
  "type": "webhook.delivery",
  "payload": { "url": "https://example.com/webhook", "event": "loan.approved" },
  "priority": "normal",
  "delayMs": 5000
}
```

**Features:**

- Configurable retry policies per job type with exponential backoff
- Dead-letter queue for jobs that exhaust retries
- Job inspection and metrics endpoints
- Correlation ID support for distributed tracing

### Data Export

Privacy-safe data exports with schema versioning and retention limits:

- `POST /api/v1/exports` - Request a data export
- `GET /api/v1/exports/:id` - Get export status and download URL
- `GET /api/v1/exports` - List all exports for the authenticated user

**Requesting an export:**

```typescript
POST /api/v1/exports
{
  "scope": "user_data",
  "format": "json",
  "schemaVersion": "1.0.0",
  "retentionDays": 7
}
```

**Export scopes:**

- `user_data` - Non-sensitive user profile and preferences
- `portfolio` - Portfolio holdings and performance history
- `audit_log` - Audit trail entries for the user
- `transaction_history` - Transaction history for the user

**Features:**

- Schema versioning for export format compatibility
- Automatic expiration and cleanup of old exports
- Privacy filters that strip sensitive fields (passwords, keys, etc.)
- Authorization checks ensuring users can only access their own exports

## Configuration & deployment

- Environment variables drive provider keys, DB endpoints, wallet signing keys, and feature flags.
- Rate-limit tiers are configurable with `RATE_LIMIT_FREE_PER_MINUTE`, `RATE_LIMIT_PAID_PER_MINUTE`, and `RATE_LIMIT_ENTERPRISE_PER_MINUTE`.
- Use the simulator environment for safe, deterministic testing before enabling live on‑chain submission.
- Run behind an API gateway for rate limiting and authentication; use TLS for all external endpoints.
- Store signing keys in a KMS and follow key rotation practices.
- Use Sentry for error tracking and performance monitoring in production.
- **Security:** Complete `SECURITY_AUDIT.md` before production deployment.

### Sentry configuration

- `SENTRY_DSN` - Sentry project data source name.
- `SENTRY_ENVIRONMENT` - Environment tag (`development`, `staging`, `production`).
- `SENTRY_RELEASE` - Release version for deployment tracking.
- `SENTRY_TRACES_SAMPLE_RATE` - Performance sampling rate (0.0 to 1.0).

## Operational notes

## Operational notes

- Run simulator and smoke tests after configuration changes.
- Monitor metrics and set alerts for submission failures, latency spikes, and abnormal agent activity.
- Ensure on‑chain submitter transactions are batched and retried safely.

## Developer guidelines

- Follow NestJS module boundaries and dependency injection best practices.
- Keep provider adapters small and testable; use interfaces to swap implementations.
- Write DTOs for all controller inputs and use class‑validation for strict contracts.
- Add unit and integration tests for service logic and gateway flows.

## Documentation

- [docs/OPERATIONAL_RUNBOOK.md](docs/OPERATIONAL_RUNBOOK.md) - Incident triage, mitigation, rollback, and recovery procedures

Every markdown document in this repository, grouped by topic:

### Project

- [CHANGELOG.md](CHANGELOG.md) - Notable changes to the project by release
- [PROJECT_STATUS.md](PROJECT_STATUS.md) - Point-in-time report on module completeness and outstanding work
- [ROADMAP.md](ROADMAP.md) - Planned direction for the off-chain services suite
- [TODO.md](TODO.md) - Open implementation tasks
- [CONTRIBUTING.md](CONTRIBUTING.md) - How to propose changes and submit pull requests
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - Community standards for participation
- [MODULE_REVIEW_CHECKLIST.md](MODULE_REVIEW_CHECKLIST.md) - Checklist maintainers use when reviewing a new pluggable module
- [WAVE_ISSUES.md](WAVE_ISSUES.md) - Wave Program issue set for this repository
- [GITHUB_ISSUES_BOOTSTRAP.md](GITHUB_ISSUES_BOOTSTRAP.md) - Starter "good first issue" templates for growing contributor activity

### API & Integration

- [docs/GRAPHQL_GATEWAY.md](docs/GRAPHQL_GATEWAY.md) - GraphQL gateway schema, cursor pagination, and typed client example
- [docs/RBAC.md](docs/RBAC.md) - Role-based access control: roles, guards, and token-claim mapping
- [docs/WEBSOCKET_SPECIFICATION.md](docs/WEBSOCKET_SPECIFICATION.md) - WebSocket event contract for real-time agent updates
- [docs/MULTI_WALLET_MANAGEMENT.md](docs/MULTI_WALLET_MANAGEMENT.md) - Multi-wallet support and related API endpoints
- [docs/module-registry.md](docs/module-registry.md) - How the pluggable module registry installs packages without touching core
- [docs/stellar-reconciliation.md](docs/stellar-reconciliation.md) - Reconciliation of confirmed Stellar payments against internal invoices
- [docs/POLICY_ENGINE.md](docs/POLICY_ENGINE.md) - Configurable business-rule evaluation and trading policy settings

### Portfolio Optimization

- [docs/PORTFOLIO_OPTIMIZATION.md](docs/PORTFOLIO_OPTIMIZATION.md) - Overview of the AI-powered portfolio optimization system
- [docs/PORTFOLIO_INTEGRATION.md](docs/PORTFOLIO_INTEGRATION.md) - Integration architecture guide
- [docs/PORTFOLIO_SETUP.md](docs/PORTFOLIO_SETUP.md) - Prerequisites and configuration steps
- [docs/PORTFOLIO_QUICK_START.md](docs/PORTFOLIO_QUICK_START.md) - Installation and quick-start walkthrough

> These four documents cover overlapping ground and are candidates for consolidation into a single portfolio guide — flagged here, not addressed in this change.

### Operations & Observability

- [docs/monitoring.md](docs/monitoring.md) - Observability stack overview (logging, metrics, tracing)
- [monitoring/README.md](monitoring/README.md) - Operational monitoring stack configuration (Prometheus/Grafana)
- [docs/kubernetes-health-probes.md](docs/kubernetes-health-probes.md) - Liveness, readiness, and startup probe configuration for Kubernetes
- [PROFILING.md](PROFILING.md) - Performance monitoring and profiling documentation
- [src/observability/PROFILING_GUIDE.md](src/observability/PROFILING_GUIDE.md) - Guide to using the built-in profiling tools

### Modules

- [src/payments/README.md](src/payments/README.md) - Plugin architecture for payment processor backends
- [modules/example-grant-module/README.md](modules/example-grant-module/README.md) - Minimal runtime-safe example of a registry module

## Contributing

Contributions are welcome. Open issues for feature requests or bugs. Follow repository contribution guidelines and include tests for significant changes.

## Support & contact

For architecture or integration questions, open an issue in this repository or contact the maintainers via the repository's issue tracker.

## License

Specify the project license here.

## Maintainers

- (Add maintainers here)
