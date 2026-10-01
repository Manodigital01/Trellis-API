# Monitoring & Observability

The Trellis API ships with a lightweight, production-ready observability
stack: **Prometheus metrics**, **OpenTelemetry tracing**, and **Grafana
dashboards**. This document covers what is exposed, how to enable it, and how to
run the local monitoring stack.

## Architecture

```
┌────────────────────────┐   scrape :15s   ┌────────────┐  queries  ┌─────────┐
│  Trellis API   │ ───────────────▶│ Prometheus │ ─────────▶│ Grafana │
│  /observability/metrics│                 └────────────┘           └─────────┘
│                        │   OTLP traces    ┌────────────┐
│  OpenTelemetry SDK     │ ───────────────▶│   Jaeger    │
└────────────────────────┘                 └────────────┘
```

- **Metrics** are collected with [`prom-client`](https://github.com/siimon/prom-client)
  (`src/config/metrics.ts`), populated by `RequestTimingMiddleware`,
  `DatabaseTimingInterceptor`, and service-level counters, then exposed in
  Prometheus text-exposition format at `GET /api/v1/observability/metrics`.
- **Traces** are captured by the OpenTelemetry Node SDK (`src/config/tracing.ts`),
  wrapped per-request by `TracingInterceptor`, and exported over OTLP/HTTP to
  Jaeger (or any OTLP collector).
- **Dashboards** are provisioned from `monitoring/grafana/`.

## Enabling monitoring

All observability is controlled through environment variables. See
`.env.example` for the full annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRACING_ENABLED` | `true` | Master toggle for OpenTelemetry tracing. Set `false` to remove tracing overhead entirely. |
| `OTEL_TRACES_SAMPLER_RATIO` | `1.0` (dev) / `0.1` (prod) | Fraction of traces to sample, `0.0`–`1.0`. Uses a parent-based ratio sampler so a sampled upstream trace stays sampled. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP/HTTP endpoint for trace export. |
| `JAEGER_ENDPOINT` / `JAEGER_AGENT_HOST` | _unset_ | Optional legacy Jaeger Thrift exporter for older Jaeger deployments. |
| `METRICS_AUTH_TOKEN` | _unset_ | When set, `/observability/metrics` requires this bearer token. Leave unset only on trusted private networks. |

> **Production note:** always set `METRICS_AUTH_TOKEN` and keep
> `OTEL_TRACES_SAMPLER_RATIO` low (e.g. `0.1`) to bound overhead.

## Metrics reference

Default process/runtime metrics are exported under the `trellis_`
prefix (CPU, resident memory, heap usage, event-loop lag, uptime). Application
metrics include:

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `trellis_http_requests_total` | Counter | `method`, `route`, `status_code` | Total HTTP requests. |
| `trellis_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Request latency distribution. |
| `trellis_http_requests_in_progress` | Gauge | `method`, `route` | In-flight requests. |
| `trellis_errors_total` | Counter | `type`, `severity` | Errors (HTTP `>=400` and internal). |
| `trellis_database_query_duration_seconds` | Histogram | `operation`, `table` | DB query latency. |
| `trellis_active_connections` | Gauge | `type` | Active connections. |
| `trellis_job_*` / `queue_length` | Histogram/Counter/Gauge | varies | Compute-job queue signals. |
| `trellis_business_operation_duration_seconds` | Histogram | `operation`, `actor_type`, `result` | Latency distribution of critical business operations. |
| `trellis_business_operation_total` | Counter | `operation`, `actor_type`, `result` | Invocations of critical business operations. |
| `trellis_business_failure_total` | Counter | `operation`, `actor_type`, `error_code` | Business operation failures by error code. |
| `trellis_conversion_funnel_total` | Counter | `funnel`, `step`, `status` | State transitions across conversion funnels. |

> See [OBSERVABILITY_TELEMETRY.md](./OBSERVABILITY_TELEMETRY.md) for full documentation on business operation telemetry, structured logging, PromQL queries, and alerting thresholds.
> See [MAINTAINER_METRICS_PRIVACY.md](./MAINTAINER_METRICS_PRIVACY.md) for full documentation on privacy-preserving analytics aggregation, safe dimension boundaries, and maintainer insights APIs.

### Cardinality safety

Route labels are normalised in `RequestTimingMiddleware` — UUIDs, numeric IDs,
Ethereum addresses, and tx hashes are collapsed to `:uuid`, `:id`, `:address`,
and `:hash`. Unmatched paths bucket to `unmatched`. This bounds label
cardinality so Prometheus memory stays predictable regardless of traffic shape.
Avoid adding high-cardinality labels (user IDs, raw paths) to any metric.

## Tracing

`TracingInterceptor` opens a span per request, propagates upstream W3C trace
context, and records status/exception on the span. Sampling is governed by
`OTEL_TRACES_SAMPLER_RATIO` via a `ParentBasedSampler(TraceIdRatioBased)`.

**Do not put PII or secrets in span attributes.** Only method, route, status,
and request ID are attached by default; request bodies are never recorded.

## Securing the metrics endpoint

`/observability/metrics` is `@Public()` (a scraper has no JWT). When
`METRICS_AUTH_TOKEN` is set, the endpoint requires the token via either:

```bash
curl -H "Authorization: Bearer $METRICS_AUTH_TOKEN" \
  http://localhost:3001/api/v1/observability/metrics
# or
curl "http://localhost:3001/api/v1/observability/metrics?token=$METRICS_AUTH_TOKEN"
```

The comparison is constant-time. Configure the token in Prometheus with
`authorization` / `bearer_token` in the scrape config.

## Local monitoring stack

`docker-compose.yml` includes Prometheus, Grafana, and Jaeger.

```bash
docker compose up -d prometheus grafana jaeger
```

Then:

- **Prometheus** — http://localhost:9090 (scrapes the API on the Docker host via
  `host.docker.internal`; adjust `monitoring/prometheus/prometheus.yml` targets).
- **Grafana** — http://localhost:3001 (admin / admin). The Prometheus datasource
  and the "Trellis - Application Monitoring" dashboard are
  auto-provisioned from `monitoring/grafana/provisioning/`.
- **Jaeger** — http://localhost:16686 for trace search.

### Files

```
monitoring/
├── grafana/
│   ├── dashboards/application-overview.json      # 28-panel dashboard
│   └── provisioning/
│       ├── datasources/prometheus.yml            # auto-registers Prometheus
│       └── dashboards/dashboards.yml             # loads dashboards on startup
└── prometheus/
    ├── prometheus.yml                            # scrape config
    └── alerts.yml.example                        # starter SLO alerts
```

## Verifying

```bash
# Metrics endpoint returns text-exposition output
curl -s http://localhost:3001/api/v1/observability/metrics | head -20

# Generate traffic, then confirm counters increment
curl -s http://localhost:3001/api/v1/health >/dev/null
curl -s http://localhost:3001/api/v1/observability/metrics \
  | grep trellis_http_requests_total
```

Unit tests cover the metrics endpoint and the trace sampler
(`src/observability/observability.controller.spec.ts`,
`src/config/tracing.spec.ts`).
