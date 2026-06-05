# Observability, Metrics, Tracing, and Profiling

This document captures the current observability implementation for the backend API and indexer after these recent commits:

- `1fa7406` - observability stack (Loki/Grafana/Alloy).
- `a5271fc` - Prometheus metrics export + dashboard wiring.
- `49db764` - OpenTelemetry tracing + Pyroscope profiling.
- `233b2b8` - profile attribution improvements + trace-to-profile mapping tuning.

It also records known limitations and what is still missing for complete trace-to-profile linking at span granularity.

## Architecture Summary

Current setup is local-first and split by signal type:

- Logs: local backend API, frontend SSR, indexer, and trading bot runtimes write JSON log files to `tmp/logs/*.log`; deploy containers are discovered by Alloy through Docker labels.
- Metrics: backend API and indexer runtimes expose `/metrics` over HTTP; Prometheus scrapes them and Grafana reads Prometheus.
- Traces: backend API and indexer runtimes send OTLP traces directly to Tempo (`:42732`), and Grafana reads Tempo.
- Profiles: backend API and indexer runtimes send profiles directly to Pyroscope (`:42733`), and Grafana reads Pyroscope.

Observability containers run behind the `observability` compose profile in `docker-compose.yml` for local dev and `docker-compose.deploy.yml` for the public deploy stack.

## Components and Wiring

### Docker Compose

`docker-compose.yml` defines:

- `loki` (log store), bound to `127.0.0.1:42730`.
- `alloy` (log shipper/processor), reads `./tmp/logs` as read-only.
- `prometheus` (metrics scraping), host network mode for host runtime scrape.
- `tempo` (trace ingest/query), OTLP HTTP on `127.0.0.1:42732`, API on `127.0.0.1:42731`.
- `pyroscope` (profiles), bound to `127.0.0.1:42733`.
- `grafana` (UI), host network mode, bound to `127.0.0.1:42735`.

`docker-compose.deploy.yml` defines the same signal stores behind its own `observability` profile, but uses deploy-specific wiring:

- `grafana` is exposed by host bind only and listens on container port `42735`.
- Prometheus scrapes `backend:42740` and indexer worker service names such as `indexer-sync-worker:42742` using `observability/prometheus/deploy-prometheus.yml`.
- Grafana datasources use compose service names from `observability/grafana/provisioning-deploy/datasources`.
- Alloy uses Docker discovery through a read-only Docker socket and keeps only containers labeled `com.artgod.observability.logs=true`.

### Log Pipeline

- Backend launcher script `scripts/backend-dev.sh` truncates and rewrites `tmp/logs/backend-api.log`.
- Frontend launcher script `scripts/frontend-dev.sh` truncates and rewrites `tmp/logs/frontend-web.log`.
- Indexer launcher script `scripts/indexer-dev.sh` truncates and rewrites one file per worker under `tmp/logs`.
- Desktop app-data logs are split by UTC day and retained through
  `DESKTOP_LOG_RETENTION_HOURS`. They also use JSON Lines: structured
  backend/indexer/trading payloads stay parseable at line start, and plain
  child-process output is wrapped before it is written.
  The local observability setup expects the app-data log path to be exposed
  through the shared `tmp/logs` root, so trading bot files such as
  `trading-bidding-bot-YYYY-MM-DD.log` are visible to Alloy without a separate
  mount.
  Known desktop runtime log files are provisioned when the app-data log
  directory is initialized and during periodic maintenance, without truncating
  existing files, so Alloy can tail late-started wallet-bound bot logs while
  still using `tail_from_end`.
- Alloy config in `observability/alloy/config.alloy`:
    - `local.file_match` targets `/var/log/artgod/backend-api.log`, `/var/log/artgod/frontend-web.log`, `/var/log/artgod/indexer-*.log`, and `/var/log/artgod/trading-*.log`.
    - `loki.source.file` tails from end.
    - JSON parsing extracts `t`, `level`, `component`, `action`.
    - Loki labels include `level`, `component`, `action`.

### Metrics Pipeline

- Prometheus config in `observability/prometheus/prometheus.yml` scrapes:
    - `42740` backend-api
    - `42741` scheduler-worker
    - `42742` sync-worker
    - `42743` reorg-worker
    - `42744` domain-worker
    - `42745` offchain-ingest-worker
    - `42746` opensea-stream-worker
    - `42747` bootstrap-worker
    - `42748` dead-letter-worker
    - `42749` opensea-bootstrap-worker
    - `42750` opensea-reconcile-worker
    - `42751` opensea-reconcile-scheduler-worker
    - `42752` collection-extension-worker
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

Main env flags (declared in `config/settings.manifest.toml`, generated into `.env.example` and `shared/config/generated-settings-defaults.ts`, and loaded through typed config):

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

### Backend API Query-Cache Logs

Backend API responses that touch query-cache-aware paths emit structured logs from `backend/src/http/common/observability.ts` with:

- `component=BackendApi`
- `action=query_cache_response`
- sanitized `path`, allowlisted `queryKeys`, `queryParamCount`, and `redactedQueryParamCount`
- `ssrBackendRequestId` when the request came through frontend SSR
- query cache status, age, ttl, event count, per-request events, and the actual response headers set on the backend reply

The backend intentionally avoids logging raw URLs, query values, and unrecognized query keys for these diagnostics.

### Frontend SSR Backend API Logs

Frontend SSR backend fetches emit structured logs from `frontend/src/lib/backend-api.ts` with:

- `component=FrontendSSR`
- `action=backend_api_response` or `action=backend_api_failure`
- sanitized `path`, allowlisted `queryKeys`, `queryParamCount`, and `redactedQueryParamCount`
- request duration and `ssrBackendRequestId`
- cache debug headers observed on the backend response

The SSR request id is sent to the backend with `X-ArtGod-SSR-Backend-Request-Id`, which lets Grafana/Loki queries join frontend SSR fetch logs to backend API response logs without relying on browser-visible response headers.

### SSR Backend Cache Diagnostics

The public web frontend is SSR-rendered. During SSR, the browser does not call
the backend API directly; the SvelteKit server calls the backend and then returns
the rendered page to the browser. That means browser DevTools cannot show the
original backend API subrequest as a normal browser network entry.

The durable debugging path is:

1. Frontend SSR adds `X-ArtGod-SSR-Backend-Request-Id` to each backend fetch.
2. Backend HTTP observability logs the same id, sanitized request metadata,
   query-cache state, cache age/ttl, cache event count, and the actual query-cache
   response headers that were set on the Fastify reply.
3. Frontend SSR logs the backend response it observed, including sanitized
   request metadata and the query-cache headers returned by the backend.
4. SSR route loads forward an aggregate query-cache summary onto the page
   response via `frontend/src/lib/query-cache-response-headers.ts`.

Only the stable query-cache debug headers are forwarded from SSR page loads:

- `X-ArtGod-Query-Cache`
- `X-ArtGod-Query-Cache-Age-Ms`
- `X-ArtGod-Query-Cache-Ttl-Ms`
- `X-ArtGod-Query-Cache-Events`

When a page load performs multiple backend calls, the forwarded page response
headers represent the aggregate cache state. Mixed hit/miss/bypass state is
reported as `mixed`; event counts are summed; age uses the maximum observed age
and ttl uses the minimum observed ttl when all calls share the same cache state.
The exact per-backend-call headers remain available in Loki logs through the
`responseHeaders` field.

### HTTP Log Sanitization Registry

Backend API and frontend SSR logs both use the shared request-target sanitizer in
`shared/observability/http.ts`.

The sanitizer keeps:

- path only, never the origin
- allowlisted query parameter names
- total query parameter count
- redacted query parameter count

The sanitizer drops:

- raw URLs
- query parameter values
- query parameter names that are not in the allowlist

The allowlist is the registry that controls which query keys can appear in
Grafana logs. It is assembled in `shared/observability/http.ts` from exported
query-param constants owned by their feature modules:

- blockspace params from `shared/config/blockspace.ts`
- pagination params from `shared/config/pagination.ts`
- collection media params from `shared/extensions/index.ts`
- collection detail and trait params from `shared/types/browse.ts`
- activity params from `shared/types/activity-feed.ts`
- bidding params from `shared/types/trading.ts`
- small generic params from `HTTP_OBSERVABILITY_GENERIC_QUERY_PARAMS`

When adding a new safe query key, define it in the owning feature/domain module,
then import that exported constant into the sanitizer registry. Do not add raw
string literals directly in frontend/server call sites, and do not log values.

### Backend API Traces

Registered backend API and health handlers are wrapped in `backend.http.route` spans with:

- `http.method`
- `http.route`
- `artgod.deployment_mode`

The collection detail route adds low-cardinality request-shape attributes:

- `artgod.collection.limit`
- `artgod.collection.limit_present`
- `artgod.collection.cursor_present`
- `artgod.collection.token_status`
- `artgod.collection.owner_present`
- `artgod.collection.trait_filters_count`
- `artgod.collection.trait_ranges_count`
- `artgod.collection.media_mode_present`

The collection activity route also adds low-cardinality request-shape attributes:

- `artgod.activity.limit`
- `artgod.activity.limit_present`
- `artgod.activity.cursor_present`
- `artgod.activity.kind`
- `artgod.activity.extension_event`
- `artgod.activity.extension_event_present`
- `artgod.activity.traits_count`
- `artgod.activity.trait_ranges_count`
- `artgod.activity.token_filter_present`
- `artgod.activity.maker_filter_present`
- `artgod.activity.content_hash_filter_present`
- `artgod.activity.event_group_filter_present`
- `artgod.activity.media_mode_present`

The activity event preview route adds request-shape attributes for extension-owned preview rendering:

- `artgod.activity.id`
- `artgod.activity.render_mode`
- `artgod.activity.render_mode_present`

The activity use case and SQLite read model add child spans for the slow path:

- `backend.activity.media_state`
- `backend.activity.feed`
- `backend.activity.trait_facets`
- `backend.activity.trait_filter_presentation`
- `backend.activity.trait_summary_template`
- `backend.activity.token_includes`
- `backend.activity.event_media`
- `backend.activity.db.query_rows`
- `backend.activity.db.count`
- `backend.activity.db.prev_cursor`
- `backend.activity.db.event_media`

Collection-extension activity feed and preview paths add child spans around extension-specific work:

- `backend.extension.install_lookup`
- `backend.extension.resolve`
- `backend.extension.activity_event_feeds`
- `backend.extension.activity_event_preview.db_activity`
- `backend.extension.activity_event_preview.install_lookup`
- `backend.extension.activity_event_preview.modes`
- `backend.extension.activity_event_preview.resolve`

The collection detail use case and SQLite read model add child spans around the token-browser slow path:

- `backend.collection_detail.chain`
- `backend.collection_detail.collection`
- `backend.collection_detail.media_state`
- `backend.collection_detail.tokens`
- `backend.collection_detail.trait_facets`
- `backend.collection_detail.trait_filter_presentation`
- `backend.collection_detail.token_summary_template`
- `backend.collection_detail.token_summary_render`
- `backend.collection.db.tokens_page`
- `backend.collection.db.tokens_listing_hydration`
- `backend.collection.db.tokens_prev_cursor`
- `backend.collection.db.tokens_count`
- `backend.collection.db.trait_facets`
- `backend.collection.db.trait_range_facets`
- `backend.extension.artifacts_batch`

The trait catalog read contract adds child spans around exact minted trait counts for requested keys and optional trait scopes:

- `backend.collection_trait_catalog.chain`
- `backend.collection_trait_catalog.collection`
- `backend.collection_trait_catalog.facets`
- `backend.collection.db.trait_catalog`

Effective range facets, whether selected from extension defaults or user
customization, skip the high-cardinality value list and return only numeric range
bounds for UI range filtering.

The backend APM service name is `${BACKEND_APM_SERVICE_NAMESPACE}.api`; by default that is `artgod.backend.api`.

### RPC Logs and Metrics

Backend and indexer RPC adapters emit dedicated structured logs and matching
Prometheus metrics for JSON-RPC calls, endpoint attempts, retry scheduling,
rate-limit waits, circuit-open events, endpoint weight drift, and websocket
failover. Trading bot RPC observability is intentionally not wired in this
round.

RPC logs use stable fields:

- `workspace`: `backend` or `indexer`
- `rpcComponent`: low-cardinality adapter lane, such as `backend-rpc`,
  `primary-http-rpc`, `backfill-http-rpc`, `metadata-rpc`, or
  `scheduler-ws-rpc`
- `protocol`: `http` or `websocket`
- `method`: RPC method or websocket watch operation
- `endpointId`: low-cardinality configured endpoint id
- `endpointOrigin`: URL origin only; paths, query strings, credentials, and raw
  API-key-bearing URLs are not logged
- `configuredWeight` and `effectiveWeight`
- `attempt`, `durationMs`, `error`, `errorClass`, and retry delay fields where
  applicable

RPC metrics export with the workspace runtime prefixes:

- backend: `artgod_backend_...`
- indexer: `artgod_indexer_...`

The canonical RPC metrics are:

- `rpc.call` counter by `component`, `protocol`, `method`, `endpoint`,
  `result`, and `error_class`
- `rpc.call.duration_ms` histogram with the same labels
- `rpc.endpoint.attempt` counter by endpoint attempt result
- `rpc.endpoint.attempt.duration_ms` histogram with the same labels
- `rpc.endpoint.event` counter for lifecycle events such as `configured`,
  `attempt_started`, `attempt_succeeded`, `attempt_failed`,
  `retry_scheduled`, `connect_started`, `connected`, `head_received`,
  `connection_failed`, `reconnect_scheduled`, and `connection_stopped`
- `rpc.endpoint.configured_weight` and `rpc.endpoint.effective_weight` gauges
- `rpc.retry.attempt` counter for retry attempts scheduled after failed
  endpoint attempts; this is not a "retry succeeded" metric
- `rpc.circuit_open` counter
- `rpc.rate_limiter.wait_ms` histogram

The canonical metrics above are the only RPC metric model. Do not add parallel
RPC counters or histograms with overlapping semantics; extend the shared RPC
observer vocabulary instead.

Cache (`indexer/src/infra/cache/memory.ts`):

- `cache.hit`, `cache.miss`, `cache.set`, `cache.eviction` counters
- `cache.entries` gauge

Metadata fetch/resolve:

- `metadata.resolve.latency` histogram
- `metadata.resolve.failure` counter
- `metadata.resolve.endpoint_failure` counter (by low-cardinality endpoint id
  and component)
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

The runtime metrics dashboard has separate RPC sections for indexer and backend
workspaces. Each section shows call rate by result, endpoint failure counts,
endpoint failure percentage, call latency p95, and effective endpoint weight.
The indexer section also includes retry-attempt counts and websocket endpoint
events because websocket failover is currently indexer-owned.

Current Tempo `tracesToProfiles` mapping is:

- `service.name -> service_name`
- `worker -> worker`
- `chainId -> chain_id`
- `profileTypeId = wall:cpu:nanoseconds:wall:nanoseconds`

The profile type is intentionally `wall:cpu...` for Node workers, not `process_cpu...`.
`profile_id` mapping is intentionally omitted right now because strict profile-id selectors produced empty jumps during validation.

## Operational Insights and Pitfalls

### Logs

- If logs do not appear in Grafana Explore, verify `scripts/backend-dev.sh`, `scripts/frontend-dev.sh`, `scripts/indexer-dev.sh`, and/or the desktop supervisor are writing into `tmp/logs` and Alloy is mounted to that same host path.
- After triggering a frontend SSR page that calls the backend API, run `./scripts/check-observability-log-ingestion.sh` to verify Loki has both frontend SSR backend-fetch logs and backend API query-cache logs.
- Use `ssrBackendRequestId` in Loki to correlate `FrontendSSR/backend_api_response` entries with `BackendApi/query_cache_response` entries for the same backend call.
- Browser response headers on an SSR-rendered page show the aggregate query-cache summary forwarded by the SSR route load. Exact backend subrequest headers are recorded in the backend and frontend SSR Loki log payloads.
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

- Run focused unit tests for SSR/backend cache diagnostics:
    - `yarn workspace @artgod/shared test observability/http.test.ts`
    - `yarn workspace @artgod/backend test src/http/common/observability.test.ts src/utils/query-cache-debug.test.ts`
    - `yarn workspace @artgod/frontend test src/lib/backend-api.test.ts src/lib/backend-api-browser.test.ts src/lib/query-cache-response-headers.test.ts src/lib/blockspace-page-load.test.ts`
    - These tests are part of their normal workspace test suites; the commands above are just the focused subset for this observability path.
- Start stack:
    - `docker compose --profile observability up -d loki tempo pyroscope alloy prometheus grafana`
- Start runtimes with file logs:
    - `./scripts/backend-dev.sh`
    - `./scripts/frontend-dev.sh`
    - `./scripts/indexer-dev.sh`
- Check Loki ingestion for SSR/backend cache diagnostics:
    - `./scripts/check-observability-log-ingestion.sh`
- Check metrics endpoint:
    - `curl http://127.0.0.1:42740/metrics`
    - `curl http://127.0.0.1:42742/metrics`
    - `curl http://127.0.0.1:42752/metrics`
- Check Grafana:
    - logs in Loki Explore
    - `up{job="artgod-backend"}` in Prometheus Explore
    - `up{job="artgod-indexer"}` in Prometheus Explore
    - traces visible in Tempo
    - profiles visible in Pyroscope with `wall:cpu` profile type
