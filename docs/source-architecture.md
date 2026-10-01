# Source layout and proposed boundaries

This inventory covers every top-level directory currently under `src/`.
"Used by" names the main consumers or entry points, not every import.

| Directory | Current responsibility | Used by |
| --- | --- | --- |
| `api` | API versioning and response contracts | controllers and `app.module.ts` |
| `billing` | subscription and invoice behavior | `app.module.ts`, payments |
| `blockchain` | oracle payload, signing, submission and verification | `app.module.ts`, audit |
| `common` | shared guards, cache, filters and middleware | most feature modules |
| `config` | environment validation, quotas and TypeORM configuration | `app.module.ts`, auth, payments |
| `core` | identity, auth, users and profiles | `app.module.ts`, most user-facing features |
| `dashboard` | dashboard aggregation endpoints | app and portfolio clients |
| `defi` | protocol positions, staking, yield and transaction optimization | investment portfolio, `app.module.ts` |
| `discovery` | agent reviews and discovery | `app.module.ts`, GraphQL |
| `email` | email delivery and logs | auth, notifications, `app.module.ts` |
| `graphql` | GraphQL gateway and resolvers | `app.module.ts`, feature services |
| `growth` | alerts and referral event contract | auth, investment portfolio, `app.module.ts` |
| `health` | liveness and readiness | `app.module.ts`, deployment monitoring |
| `infrastructure` | audit, uploads and webhooks | `app.module.ts`, auth, portfolio |
| `investment` | portfolio model, holdings, analytics, trading, rebalancing and risk | `app.module.ts`, dashboard, growth |
| `logging` | application logger setup | `app.module.ts`, services |
| `migrations` | database schema changes | TypeORM migration runner |
| `models` | shared model definitions | feature modules |
| `modules` | tenant-aware external module registry and lifecycle | `app.module.ts`, root `modules/` packages |
| `monitoring` | operational metrics and monitoring | `app.module.ts` |
| `notifications` | notification preferences and delivery | growth, `app.module.ts` |
| `observability` | tracing and instrumentation | `app.module.ts` |
| `payments` | payment processor adapters and Stellar Horizon path | billing, `app.module.ts` |
| `portfolio` | separate placeholder rebalancing controller and service | its own module; not imported by `app.module.ts` |
| `preflight` | deterministic pre-submission evaluation of high-risk operations | callers of payments, trading and oracle flows; `app.module.ts` |
| `profiling` | request and performance profiling | `app.module.ts` |
| `rate-limiting` | distributed request limits | `app.module.ts`, auth guards |
| `reconciliation` | ledger and invoice reconciliation | payments, `app.module.ts` |
| `search` | search endpoints and indexing | `app.module.ts`, discovery |
| `simulator` | simulation helpers | tests and development workflows |
| `types` | shared TypeScript contracts | feature modules |

## Portfolio boundary

`src/investment/portfolio` is the active portfolio domain. Its entities own
holdings and current value; its services own trading, analytics, rebalancing and
prediction. `src/portfolio` contains a second controller and a rebalancing stub,
but `AppModule` imports only the investment portfolio module. `src/defi` owns
protocol positions, staking and yield; portfolio may call its transaction
optimization service, but DeFi positions are not portfolio holdings. This is
the genuine overlap. `src/modules/registry` is different: it manages optional
external packages, not built-in Nest feature modules.

The proposed target is one portfolio home under `src/investment/portfolio`.
New holdings, allocation, trading and rebalancing code belongs there. Protocol
adapters stay under `src/defi`, and shared infrastructure stays outside both.
After maintainers agree to this boundary, remove or migrate the inactive
`src/portfolio` stub in a focused change, then update imports and tests. No
files are moved here because issue #20 explicitly requires agreement before
moving files. The current runtime layout and behavior remain as described.
