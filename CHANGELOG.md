# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Dependency health checks with public critical-only summary, admin diagnostics
  and a `npm run deps:health` CLI ([#124](docs/dependency-health.md))
- Progressive transaction details via `details=summary|standard|advanced` and
  `dryRun=true` previews ([#125](docs/transaction-details.md))
- Machine-readable protocol changelog with JSON Schema validation,
  `GET /changelog/protocol` and `npm run changelog:validate`
  ([#126](docs/protocol-changelog.md)); the source of truth for protocol changes
  is [`changelog/protocol-changes.json`](changelog/protocol-changes.json)
- Deterministic fault-injection harness and failure-mode suites for
  reconciliation and on-chain submission ([#127](docs/fault-injection.md))
- Comprehensive documentation for portfolio optimization
- WebSocket reconnection service with exponential backoff
- Connection pool management for dashboard WebSockets
- Event buffering to prevent WebSocket flooding
- Multi-wallet management system
- KYC guard with comprehensive coverage scanning
- Rate limiting for sensitive endpoints
- Token blacklisting service for secure session management
- OpenTelemetry distributed tracing integration
- Sentry error tracking and performance monitoring
- Prometheus metrics with Grafana dashboards
- Kubernetes health probes and liveness/readiness checks

### Security
- Added helmet security headers
- Implemented CORS whitelisting
- Added input sanitization on all endpoints
- Enhanced password hashing with bcrypt
- JWT token with secure expiration

### Fixed
- TypeScript compilation errors across all modules
- Memory leaks in WebSocket connections
- Race conditions in oracle submission batching
- SQL injection vulnerabilities in query builders

## [0.1.0] - 2026-07-31

### Added
- Initial NestJS project structure
- Basic authentication system
- Blockchain oracle module
- DeFi portfolio tracking
- Real-time dashboard WebSocket gateway
- Core user profile management
- Basic AI compute bridge

[Unreleased]: https://github.com/TRELLIS-STELLAR/Trellis-API/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TRELLIS-STELLAR/Trellis-API/releases/tag/v0.1.0