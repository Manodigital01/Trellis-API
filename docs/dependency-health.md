# Dependency health checks

Issue: [#124](https://github.com/TRELLIS-STELLAR/Trellis-API/issues/124)

Trellis depends on services that are not in this process: PostgreSQL, Redis,
Horizon, an Ethereum RPC, object storage, SMTP, Elasticsearch, tracing and error
reporting. This feature makes each dependency's state explicit instead of
letting a call fail somewhere deep inside a request.

## The five states

| State | Meaning | Gates readiness |
| --- | --- | --- |
| `healthy` | Answered inside its latency budget. | No |
| `degraded` | Answered, but slower than the budget. | No (advisory) |
| `unavailable` | Could not be reached at all. | Only if critical |
| `misconfigured` | Required configuration is missing or invalid. | Only if critical |
| `disabled` | Not configured, and not required. | No |

A dependency is `critical` or `optional`. `database`, `redis`,
`stellar_horizon`, `stellar_network_passphrase` and `eth_rpc` are critical;
everything else is optional. Optional dependencies produce findings but never
fail readiness, so a deployment without Sentry or SMTP is not reported as broken.

`disabled` never makes a report unhealthy. An optional service that is switched
off is a configuration choice, not a fault.

## Endpoints

### `GET /health/dependencies` (public)

Returns the worst state of the **critical** dependencies and a per-dependency
breakdown. Runs **local checks only**: it reads configuration and uses the
application's own database pool and Redis client, but it never makes an outbound
HTTP request, so an unauthenticated caller cannot turn the endpoint into a probe
against internal networks.

- `200` when every critical dependency is healthy, degraded or disabled.
- `503` when a critical dependency is unavailable or misconfigured.

### `GET /health/dependencies/diagnostics` (admin, two-factor)

The full report for maintainers: every dependency including optional ones,
latency per check, and remediation hints. Requires `ADMIN` role plus two-factor
authentication.

- `?refresh=true` bypasses the cache and re-runs the checks.
- `?networkProbes=true` (default) allows outbound probes to configured
  dependencies. `?networkProbes=false` restricts the run to local checks.

## Command line

```bash
npm run deps:health                       # text report, network probes on
npm run deps:health -- --no-network       # local checks only
npm run deps:health -- --only database,redis,stellar_horizon
npm run deps:health -- --json             # machine-readable
```

The exit code is `0` when the critical dependencies are healthy, `1` when one is
unavailable or misconfigured, and `2` for a usage error. Use it as a
pre-deploy gate:

```bash
npm run deps:health -- --no-network || exit 1
```

## No secrets in the output

A health report ends up in logs, dashboards and terminals, so it must be safe to
paste anywhere:

- Values are never returned. Only the **names** of configuration variables and
  whether they are set.
- Connection URLs lose their userinfo, so `postgresql://user:pw@host/db`
  becomes `postgresql://host/db`.
- Query strings, tokens and anything that looks like a key are replaced with
  `***REDACTED***`.
- Long opaque strings (signatures, hashes) are masked.
- Messages are truncated to a fixed length.

`isSecretEnvKey` recognises the variable names to treat as secret even when the
value does not look like one.

## No hidden network assumptions

A dependency with no configuration is reported as `disabled` and **not probed**.
The registry never falls back to a compiled-in default address, because that
would hide the assumption: a request to a guessed host either fails (noise) or
succeeds (false confidence). This is why an unset `ELASTICSEARCH_URL` shows as
disabled rather than as a probe of `http://localhost:9200`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEPENDENCY_HEALTH_ENABLED` | `true` | Master switch. `false` reports every dependency as `disabled`. |
| `DEPENDENCY_HEALTH_TIMEOUT_MS` | `2000` | Per-probe budget. |
| `DEPENDENCY_HEALTH_DEGRADED_LATENCY_MS` | `500` | Latency above which a reachable dependency is `degraded`. |
| `DEPENDENCY_HEALTH_CACHE_TTL_MS` | `5000` | How long a report is reused. The public route honours it; `?refresh=true` bypasses it. |

## Extending it

Add a `DependencyDefinition` in `src/dependency-health/dependency-health.registry.ts`
with its `configKeys`, remediation strings and a pure `probe` function. The
registry is shared by the Nest service and the CLI, so a new dependency appears
in both. Keep probes pure: they receive a `DependencyProbeContext` and return an
outcome, and the runner handles timeouts, sanitisation and state classification.
