# Observability, Metrics, Tracing, and Profiling

This document captures the current observability implementation for the backend API and indexer after these recent commits:

- `1fa7406` - observability stack (Loki/Grafana/Alloy).
- `a5271fc` - Prometheus metrics export + dashboard wiring.
- `49db764` - OpenTelemetry tracing + Pyroscope profiling.
- `233b2b8` - profile attribution improvements + trace-to-profile mapping tuning.

It also records known limitations and what is still missing for complete trace-to-profile linking at span granularity.

## Architecture Summary

Current setup is local-first and split by signal type:

- Logs: local backend API and indexer runtimes write JSON log files to `tmp/logs/*.log`; deploy containers are discovered by Alloy through Docker labels.
- Metrics: backend API and indexer runtimes expose `/metrics` over HTTP; Prometheus scrapes them and Grafana reads Prometheus.
- Traces: backend API and indexer runtimes send OTLP traces directly to Tempo (`:4318`), and Grafana reads Tempo.
- Profiles: backend API and indexer runtimes send profiles directly to Pyroscope (`:4040`), and Grafana reads Pyroscope.

Observability containers run behind the `observability` compose profile in `docker-compose.yml` for local dev and `docker-compose.deploy.yml` for the public deploy stack.

## Components and Wiring

### Docker Compose

`docker-compose.yml` defines:

- `loki` (log store), bound to `127.0.0.1:3100`.
- `alloy` (log shipper/processor), reads `./tmp/logs` as read-only.
- `prometheus` (metrics scraping), host network mode for host runtime scrape.
- `tempo` (trace ingest/query), OTLP HTTP on `127.0.0.1:4318`, API on `127.0.0.1:3200`.
- `pyroscope` (profiles), bound to `127.0.0.1:4040`.
- `grafana` (UI), host network mode, bound to `127.0.0.1:42701`.

`docker-compose.deploy.yml` defines the same signal stores behind its own `observability` profile, but uses deploy-specific wiring:

- `grafana` joins the external `public-edge` network with alias `artgod-grafana` and listens on container port `3000`.
- Prometheus scrapes `backend:9480` and indexer worker service names such as `indexer-sync-worker:9465` using `observability/prometheus/deploy-prometheus.yml`.
- Grafana datasources use compose service names from `observability/grafana/provisioning-deploy/datasources`.
- Alloy uses Docker discovery through a read-only Docker socket and keeps only containers labeled `com.artgod.observability.logs=true`.

### Log Pipeline

- Backend launcher script `scripts/backend-dev.sh` truncates and rewrites `tmp/logs/backend-api.log`.
- Indexer launcher script `scripts/indexer-dev.sh` truncates and rewrites one file per worker under `tmp/logs`.
- Alloy config in `observability/alloy/config.alloy`:
    - `local.file_match` targets `/var/log/artgod/backend-api.log` and `/var/log/artgod/indexer-*.log`.
    - `loki.source.file` tails from end.
    - JSON parsing extracts `t`, `level`, `component`, `action`.
    - Loki labels include `level`, `component`, `action`.

### Metrics Pipeline

- Prometheus config in `observability/prometheus/prometheus.yml` scrapes:
    - `9480` backend-api
    - `9464` scheduler-worker
    - `9465` sync-worker
    - `9466` reorg-worker
    - `9467` domain-worker
    - `9468` offchain-ingest-worker
    - `9469` opensea-stream-worker
    - `9470` bootstrap-worker
    - `9471` dead-letter-worker
    - `9472` opensea-bootstrap-worker
    - `9473` opensea-reconcile-worker
    - `9474` opensea-reconcile-scheduler-worker
    - `9475` collection-extension-worker
- Runtime metrics bootstrap:
    - `shared/observability/metrics/runtime.ts` initializes generic runtime metrics only when enabled.
    - `backend/src/observability/metrics.ts` initializes backend-specific metrics with the `artgod_backend_` prefix.
    - `shared/observability/metrics/prometheus.ts` lazily imports `prom-client`.
    - `shared/observability/metrics/server.ts` exposes `/metrics` and `/healthz`.

### Trace Pipeline

- Runtime APM bootstrap:
    - `shared/observability/apm.ts` lazily imports OpenTelemetry packages.
    - `withSpan(name, attributes, run)` is the single tracing API.
    - backend spans wrap registered API route handlers.
    - indexer spans are created around scheduler-worker actions and queue-consumer handlers.
    - exports via OTLP HTTP to `INDEXER_APM_OTLP_HTTP_URL`, or the composition-level `OBSERVABILITY_OTLP_HTTP_URL` when the indexer-specific override is omitted.

### Profile Pipeline

- Same `apm.ts` lazily imports `@pyroscope/nodejs`.
- profiler uses app name `${INDEXER_APM_SERVICE_NAMESPACE}.${worker}`.
- base tags: `service_name`, `worker`, `chain_id`.
- span profile linking mode adds dynamic labels via `wrapWithLabels`:
    - `profile_id=<spanId>`
    - `service_name`, `worker`, `chain_id`
- traces also get span attribute: `pyroscope.profile.id=<spanId>` when enabled.

## Runtime Config

Main env flags (in `.env.example` and loaded through typed config):

- `OBSERVABILITY_OTLP_HTTP_URL`
- `OBSERVABILITY_PYROSCOPE_URL`
- `INDEXER_METRICS_ENABLED`
- `INDEXER_METRICS_HOST` (default `0.0.0.0`)
- `INDEXER_METRICS_PORT_*` for each runtime
- `BACKEND_METRICS_ENABLED`
- `BACKEND_METRICS_HOST`
- `BACKEND_METRICS_PORT`
- `INDEXER_APM_ENABLED`
- `INDEXER_APM_SERVICE_NAMESPACE`
- `INDEXER_APM_TRACES_ENABLED`
- `INDEXER_APM_OTLP_HTTP_URL` (optional override)
- `INDEXER_APM_PROFILES_ENABLED`
- `INDEXER_APM_PYROSCOPE_URL` (optional override)
- `INDEXER_APM_SPAN_PROFILES_ENABLED`
- `BACKEND_APM_ENABLED`
- `BACKEND_APM_SERVICE_NAMESPACE`
- `BACKEND_APM_TRACES_ENABLED`
- `BACKEND_APM_OTLP_HTTP_URL` (optional override)
- `BACKEND_APM_PROFILES_ENABLED`
- `BACKEND_APM_PYROSCOPE_URL` (optional override)
- `BACKEND_APM_SPAN_PROFILES_ENABLED`

Design notes:

- metrics and APM exporters are optional and degrade to no-op paths when disabled.
- packages are loaded lazily at runtime; missing packages do not crash observability-disabled runs.
- Observability config accepts workspace-specific names (`INDEXER_*`, `BACKEND_*`) and composition-level endpoint names (`OBSERVABILITY_*`) only.

## What Is Instrumented Today

### Backend API Metrics

Fastify lifecycle hooks in `backend/src/http/common/observability.ts` emit:

- `http.requests` counter by method, route, and status class
- `http.request.duration_ms` histogram for total request latency
- `http.pre_handler.duration_ms` histogram for routing, security, and pre-handler work
- `http.handler.duration_ms` histogram for HTTP adapter and use-case work
- `http.response_send.duration_ms` histogram for response serialization/send time
- `http.inflight.requests` gauge by method and route
- `http.request.errors` exception counter by method, route, and error class
- `query_cache.requests`, `query_cache.age_ms`, `query_cache.ttl_ms` for cached backend query paths that set cache debug context

These export with the `artgod_backend_` Prometheus prefix.

### Backend API Traces

Registered backend API and health handlers are wrapped in `backend.http.route` spans with:

- `http.method`
- `http.route`
- `artgod.deployment_mode`

The backend APM service name is `${BACKEND_APM_SERVICE_NAMESPACE}.api`; by default that is `artgod.backend.api`.

### Metrics (current hooks)

RPC (`indexer/src/infra/rpc/viem.ts`):

- `rpc.latency` histogram (by method)
- `rpc.failure` counter
- `rpc.retry` counter
- `rpc.circuit_open` counter
- `rpc.rate_limiter.wait_ms` histogram

Cache (`indexer/src/infra/cache/memory.ts`):

- `cache.hit`, `cache.miss`, `cache.set`, `cache.eviction` counters
- `cache.entries` gauge

Metadata fetch/resolve:

- `metadata.resolve.latency` histogram
- `metadata.resolve.failure` counter
- `metadata.fetch.latency` histogram
- `metadata.fetch.success`, `metadata.fetch.failure` counters

### Traces

Scheduler-worker spans in `indexer/src/application/scheduler-worker.ts`:

- `scheduler-worker.bootstrap.realtime`
- `scheduler-worker.bootstrap.blockChecks`
- `scheduler-worker.head.poll`
- `scheduler-worker.head.ws`

Queue consumer spans via `runWorker` in `indexer/src/application/worker-runner.ts`:

- `worker.realtimeSync.consume`
- `worker.backfillSync.consume`
- `worker.reorgCheck.consume`
- `worker.bootstrap.consume`
- `worker.ordersDomain.consume`
- `worker.ordersUpdateByMaker.consume`
- `worker.ordersUpdateById.consume`
- `worker.ordersUpsert.consume`
- `worker.metadataDomain.consume`
- `worker.metadataRefresh.consume`
- `worker.metadataStats.consume`
- `worker.activityDomain.consume`
- `worker.collectionExtension.consume`
- `worker.offchainIngest.consume`
- `worker.openseaBootstrap.consume`
- `worker.openseaReconcile.consume`
- `worker.deadLetter.consume`

OpenSea stream publish path has explicit span:

- `worker.openseaStream.publish`

The OpenSea reconcile scheduler currently runs on a timer loop and logs directly rather than through `runWorker`.

## Grafana Provisioning

Provisioned datasources:

- Loki: `observability/grafana/provisioning/datasources/loki.yaml`
- Prometheus: `observability/grafana/provisioning/datasources/prometheus.yaml`
- Tempo: `observability/grafana/provisioning/datasources/tempo.yaml`
- Pyroscope: `observability/grafana/provisioning/datasources/pyroscope.yaml`

Provisioned dashboard:

- `observability/grafana/provisioning/dashboards/runtime-metrics-overview.json`

Current Tempo `tracesToProfiles` mapping is:

- `service.name -> service_name`
- `worker -> worker`
- `chainId -> chain_id`
- `profileTypeId = wall:cpu:nanoseconds:wall:nanoseconds`

The profile type is intentionally `wall:cpu...` for Node workers, not `process_cpu...`.
`profile_id` mapping is intentionally omitted right now because strict profile-id selectors produced empty jumps during validation.

## Operational Insights and Pitfalls

### Logs

- If logs do not appear in Grafana Explore, verify `scripts/backend-dev.sh` and/or `scripts/indexer-dev.sh` are writing into `tmp/logs` and Alloy is mounted to that same host path.
- Because worker logs are truncated on worker start, tail behavior is easiest to reason about when observability stack is already running before worker startup.

### Metrics

- `up{job="artgod-backend"}` should show the backend API scrape target when `BACKEND_METRICS_ENABLED=true`.
- `up{job="artgod-indexer"}` should show runtimes as healthy once workers are up and `INDEXER_METRICS_ENABLED=true`.
- if `/metrics` works locally but Prometheus is empty, check host/container networking and host firewall policy (especially custom Docker/DOCKER-USER rules).
- `INDEXER_METRICS_HOST=0.0.0.0` is required for host-based scraping setups used here.

### Pyroscope and Explore

- Pyroscope Explore requires the correct profile type selected; label selector alone is insufficient.
- for Node workers, using `process_cpu:*` can appear empty; use `wall:cpu:*`.
- service labels can differ between Drilldown and Explore expectations if selector/profile type do not match active series.

### Dashboard Query Gotcha

- The "All Custom Counter Rates (5m)" panel requires aggregation preserving a unique label set.
- avoid queries that collapse different metrics into identical labels; keep `metric` in the group-by.

## Current Trace-to-Profile Linking Status

What works now:

- Traces and profiles are both collected per runtime.
- Tempo "Related Profiles" can jump by stable labels (`service_name`, `worker`, `chain_id`).
- spans include `pyroscope.profile.id` when span profile linking is enabled.

What is still missing for complete linking:

- true span-level guaranteed jump (trace span -> exact profile slice keyed by `profile_id`) is not fully reliable yet.
- even though `pyroscope.profile.id` is emitted on spans and `wrapWithLabels` is used, `profile_id` is not yet consistently queryable/indexed as a first-class label in Pyroscope series for this runtime path.
- result: profile navigation is currently best-effort at service/worker/chain granularity, not strict one-span isolation.

## Remaining Work

To reach full trace-profile correlation:

- validate and enforce `profile_id` presence as an indexed/queryable label in stored Pyroscope series for Node runtime profiles.
- once confirmed, re-enable strict `profile_id` mapping in Tempo `tracesToProfiles` tags (currently omitted to avoid no-result jumps).
- add targeted integration checks that verify:
    - span has `pyroscope.profile.id`
    - matching Pyroscope series exists with same label/value
    - Grafana Related Profiles returns non-empty result for that span.

## Quick Verification Checklist

- Start stack:
    - `docker compose --profile observability up -d loki tempo pyroscope alloy prometheus grafana`
- Start runtimes with file logs:
    - `./scripts/backend-dev.sh`
    - `./scripts/indexer-dev.sh`
- Check metrics endpoint:
    - `curl http://127.0.0.1:9480/metrics`
    - `curl http://127.0.0.1:9465/metrics`
    - `curl http://127.0.0.1:9475/metrics`
- Check Grafana:
    - logs in Loki Explore
    - `up{job="artgod-backend"}` in Prometheus Explore
    - `up{job="artgod-indexer"}` in Prometheus Explore
    - traces visible in Tempo
    - profiles visible in Pyroscope with `wall:cpu` profile type
