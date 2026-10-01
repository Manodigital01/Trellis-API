# Contributing to Trellis API

First off, thanks for taking the time to contribute! ❤️

All types of contributions are encouraged and valued. See the [Table of Contents](#table-of-contents) for different ways to help and details about how this project handles them. Please make sure to read the relevant section before making your contribution. It will make it a lot easier for us maintainers and smooth out the experience for all involved.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [I Have a Question](#i-have-a-question)
- [I Want To Contribute](#i-want-to-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Enhancements](#suggesting-enhancements)
  - [Your First Code Contribution](#your-first-code-contribution)
  - [Improving The Documentation](#improving-the-documentation)
- [Styleguides](#styleguides)
  - [Commit Messages](#commit-messages)
  - [TypeScript Styleguide](#typescript-styleguide)
- [Join The Project Team](#join-the-project-team)

## Code of Conduct

This project and everyone participating in it is governed by the [Trellis API Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to <conduct@trellis.example>.

## I Have a Question

Before you ask a question, it is best to search for existing [Issues](https://github.com/TRELLIS-STELLAR/Trellis-API/issues) that might help you. In case you have found a suitable issue and still need clarification, you can write your question in that issue. It is also advisable to search the internet for answers first.

If you still have questions, feel free to reach out via GitHub Discussions.

## I Want To Contribute

### Reporting Bugs

#### Before Submitting a Bug Report

- Make sure that you are using the latest version.
- Check that your issue hasn't already been reported.
- Collect information about the issue to help us fix it quickly.

#### How Do I Submit a Good Bug Report?

Use the bug report template to create a detailed issue. Include:
- A quick summary and/or background
- Steps to reproduce
- What you expected would happen
- What actually happens
- Notes (potentially including why you think this is happening)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. Create an issue and provide:
- A clear and descriptive title
- Step-by-step description of the suggested enhancement
- Current behavior vs. expected behavior
- Screenshots if applicable
- Explain why this enhancement would be useful

### Your First Code Contribution

1. Fork the repository
2. Clone your fork
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Run tests: `npm test`
6. Commit your changes
7. Push to your fork
8. Open a Pull Request

#### Local Development Setup

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# ── Run contributor diagnostics before starting ─────────────────────────────
# Checks your tools, environment variables, database, Redis, and external
# services. Always run this after cloning or updating your .env.
npm run diagnostics

# For a faster check that skips network probes:
npm run diagnostics:quick

# Start development server
npm run start:dev

# Run tests
npm run test

# Run linting
npm run lint
```

### Sandbox Mode (no credentials required)

If you are working on the payment or chain integration and do not want to
configure PostgreSQL, Redis, Stellar or Grantfox, use **integration sandbox
mode**. It swaps the external payment dependency for deterministic fakes that
need no secrets and never touch a real network or ledger.

```bash
# Run the full create → sign → submit → status → refund workflow, offline
npm run sandbox:demo

# Sandbox test suite
npm run test:sandbox
```

Set `SANDBOX_MODE=true` in `.env` to enable it for the running API and select
the processor per request with `X-Payment-Processor: sandbox` (or
`PAYMENTS_DEFAULT_PROCESSOR=sandbox`). It is refused when
`NODE_ENV=production`. See [docs/SANDBOX_MODE.md](docs/SANDBOX_MODE.md) for the
available scenarios, configuration and limitations.

### Environment Configuration

The API validates all required secrets at startup. Invalid or placeholder values
cause a fast-fail with an actionable error message. See [.env.example](.env.example)
for the full list of supported variables.

**Required for core functionality:**
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — 32+ character random string (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

**Required for specific features:**
- `REDIS_URL` — Redis URL for rate limiting, caching, and Bull queues
- `STELLAR_HORIZON_URL` + `STELLAR_SIGNING_SECRET` — Stellar payment integration
- `OPENAI_API_KEY` — AI compute features
- `SMTP_HOST` + `SMTP_*` — Email notifications

Production deployments additionally validate that secrets are not placeholders
and that localhost URLs are not used.

### API Versioning

All routes are served under `/api/v1/...` by default. Version 2 routes
(when introduced) are accessible at `/api/v2/...`. Deprecated routes will
carry `Deprecation` and `Sunset` HTTP headers pointing to migration guides.

### Quota Management

Expensive operations (AI token usage, oracle submissions, file uploads, compute
jobs) enforce per-user budget quotas. Administrators can inspect and reset
quotas via:
- `GET /api/v1/admin/quota/policies` — list all quota policies
- `GET /api/v1/admin/quota/usage/:resource` — per-actor usage for a resource
- `GET /api/v1/admin/quota/peek?actor=…&resource=…` — inspect a specific actor
- `DELETE /api/v1/admin/quota/reset?actor=…&resource=…` — reset an actor's quota

All admin quota endpoints require the `ADMIN` role.

### Diagnostics Command

Run `npm run diagnostics` at any time to verify your local setup:

| Section | What it checks |
|---|---|
| Required tools | node ≥ 18, npm, git, docker (optional), psql (optional) |
| Dependencies | node_modules present, no critical npm audit findings |
| Environment | All required `.env` vars set with non-placeholder values |
| Database | TCP reachability + optional psql query |
| Redis | TCP reachability |
| Stellar Horizon | HTTP reachability (skipped with `--quick`) |
| SMTP | TCP reachability (skipped with `--quick`) |
| Build | TypeScript type-check via `tsc --noEmit` (skipped with `--quick`) |
| Tests | Runs diagnostics-related unit tests |

The command exits 0 on pass/warn and exits 1 on any failure. It **never
mutates any data**.

### Improving The Documentation

You can help improve documentation by:
- Adding missing descriptions
- Fixing typos and grammar
- Adding tutorials and guides
- Improving existing documentation

## Styleguides

### Commit Messages

Use conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `refactor:` for code refactoring
- `test:` for adding tests
- `chore:` for build/tooling changes

Example: `feat: add new wallet authentication provider`

### TypeScript Styleguide

- Follow the existing ESLint configuration
- Use TypeScript types for all functions and variables
- Write comprehensive JSDoc comments for public APIs
- Keep functions small and focused
- Write unit tests for all new features

## Join The Project Team

If you're interested in becoming a maintainer, reach out to the core team! We're always looking for passionate contributors to help grow the project.

---

Happy coding! 🚀