# Observability, Metrics, Tracing, and Profiling

This document captures the current observability implementation for the indexer after these recent commits:

- `1fa7406` - observability stack (Loki/Grafana/Alloy).
- `a5271fc` - Prometheus metrics export + dashboard wiring.
- `49db764` - OpenTelemetry tracing + Pyroscope profiling.
- `233b2b8` - profile attribution improvements + trace-to-profile mapping tuning.

It also records known limitations and what is still missing for complete trace-to-profile linking at span granularity.

## Architecture Summary

Current setup is local-first and split by signal type:

- Logs: indexer runtimes write JSON log files to `tmp/logs/*.log` on host, Alloy tails files, pushes to Loki, Grafana reads Loki.
- Metrics: each runtime exposes `/metrics` over HTTP on host ports `9464..9471`, Prometheus scrapes, Grafana reads Prometheus.
- Traces: runtimes send OTLP traces directly to Tempo (`:4318`), Grafana reads Tempo.
- Profiles: runtimes send profiles directly to Pyroscope (`:4040`), Grafana reads Pyroscope.

Observability containers run behind the `observability` compose profile in `docker-compose.yml`.

## Components and Wiring

### Docker Compose

`docker-compose.yml` defines:

- `loki` (log store), bound to `127.0.0.1:3100`.
- `alloy` (log shipper/processor), reads `./tmp/logs` as read-only.
- `prometheus` (metrics scraping), host network mode for host runtime scrape.
- `tempo` (trace ingest/query), OTLP HTTP on `127.0.0.1:4318`, API on `127.0.0.1:3200`.
- `pyroscope` (profiles), bound to `127.0.0.1:4040`.
- `grafana` (UI), host network mode, bound to `127.0.0.1:42701`.

### Log Pipeline

- Runtime launcher script `scripts/indexer-dev.sh` truncates and rewrites one file per worker under `tmp/logs`.
- Alloy config in `observability/alloy/config.alloy`:
  - `local.file_match` targets `/var/log/artgod/*.log`.
  - `loki.source.file` tails from end.
  - JSON parsing extracts `t`, `level`, `component`, `action`.
  - Loki labels include `level`, `component`, `action`.

### Metrics Pipeline

- Prometheus config in `observability/prometheus/prometheus.yml` scrapes:
  - `9464` scheduler
  - `9465` sync-worker
  - `9466` reorg-worker
  - `9467` domain-worker
  - `9468` offchain-ingest-worker
  - `9469` opensea-stream-worker
  - `9470` bootstrap-worker
  - `9471` dead-letter-worker
- Runtime metrics bootstrap:
  - `indexer/src/metrics/runtime.ts` initializes metrics only when enabled.
  - `indexer/src/metrics/prometheus.ts` lazily imports `prom-client`.
  - `indexer/src/metrics/server.ts` exposes `/metrics` and `/healthz`.

### Trace Pipeline

- Runtime APM bootstrap:
  - `indexer/src/observability/apm.ts` lazily imports OpenTelemetry packages.
  - `withSpan(name, attributes, run)` is the single tracing API.
  - spans are created around scheduler actions and queue-consumer handlers.
  - exports via OTLP HTTP to `APM_OTLP_HTTP_URL` (default Tempo).

### Profile Pipeline

- Same `apm.ts` lazily imports `@pyroscope/nodejs`.
- profiler uses app name `${APM_SERVICE_NAMESPACE}.${worker}`.
- base tags: `service_name`, `worker`, `chain_id`.
- span profile linking mode adds dynamic labels via `wrapWithLabels`:
  - `profile_id=<spanId>`
  - `service_name`, `worker`, `chain_id`
- traces also get span attribute: `pyroscope.profile.id=<spanId>` when enabled.

## Runtime Config

Main env flags (in `.env.example` and loaded through typed config):

- `METRICS_ENABLED`
- `METRICS_HOST` (default `0.0.0.0`)
- `METRICS_PORT_*` for each runtime
- `APM_ENABLED`
- `APM_SERVICE_NAMESPACE`
- `APM_TRACES_ENABLED`
- `APM_OTLP_HTTP_URL`
- `APM_PROFILES_ENABLED`
- `APM_PYROSCOPE_URL`
- `APM_SPAN_PROFILES_ENABLED`

Design notes:

- metrics and APM exporters are optional and degrade to no-op paths when disabled.
- packages are loaded lazily at runtime; missing packages do not crash observability-disabled runs.

## What Is Instrumented Today

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

Scheduler spans in `indexer/src/application/scheduler.ts`:

- `scheduler.bootstrap.realtime`
- `scheduler.bootstrap.blockChecks`
- `scheduler.head.poll`
- `scheduler.head.ws`

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
- `worker.offchainIngest.consume`
- `worker.deadLetter.consume`

OpenSea stream publish path has explicit span:

- `worker.openseaStream.publish`

## Grafana Provisioning

Provisioned datasources:

- Loki: `observability/grafana/provisioning/datasources/loki.yaml`
- Prometheus: `observability/grafana/provisioning/datasources/prometheus.yaml`
- Tempo: `observability/grafana/provisioning/datasources/tempo.yaml`
- Pyroscope: `observability/grafana/provisioning/datasources/pyroscope.yaml`

Provisioned dashboard:

- `observability/grafana/provisioning/dashboards/indexer-metrics-overview.json`

Current Tempo `tracesToProfiles` mapping is:

- `service.name -> service_name`
- `worker -> worker`
- `chainId -> chain_id`
- `profileTypeId = wall:cpu:nanoseconds:wall:nanoseconds`

The profile type is intentionally `wall:cpu...` for Node workers, not `process_cpu...`.
`profile_id` mapping is intentionally omitted right now because strict profile-id selectors produced empty jumps during validation.

## Operational Insights and Pitfalls

### Logs

- If logs do not appear in Grafana Explore, verify `scripts/indexer-dev.sh` is writing into `tmp/logs` and Alloy is mounted to that same host path.
- Because worker logs are truncated on worker start, tail behavior is easiest to reason about when observability stack is already running before worker startup.

### Metrics

- `up{job="artgod-indexer"}` should show runtimes as healthy once workers are up and `METRICS_ENABLED=true`.
- if `/metrics` works locally but Prometheus is empty, check host/container networking and host firewall policy (especially custom Docker/DOCKER-USER rules).
- `METRICS_HOST=0.0.0.0` is required for host-based scraping setups used here.

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
- Start workers with file logs:
  - `./scripts/indexer-dev.sh`
- Check metrics endpoint:
  - `curl http://127.0.0.1:9465/metrics`
- Check Grafana:
  - logs in Loki Explore
  - `up{job="artgod-indexer"}` in Prometheus Explore
  - traces visible in Tempo
  - profiles visible in Pyroscope with `wall:cpu` profile type
