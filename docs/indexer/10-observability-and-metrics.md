# Observability and Metrics

The indexer uses structured logging and a minimal metrics interface to track behavior. This document summarizes what is currently implemented and where hooks exist for more detailed telemetry.

## Logging

All runtimes use the shared logger from `@artgod/shared/utils` and emit structured logs with:

- `component` (the main runtime or domain)
- `action` (the specific operation or handler)

Examples:

- `IndexerScheduler` with actions like `start`, `poll`, `wsHead`.
- `IndexerSyncWorker` with actions like `syncBlock` and `backfillRange`.
- `IndexerReorgWorker` with action `blockCheck`.
- Domain components: `OrdersDomain`, `MetadataDomain`, `ActivityDomain`.

Logs are emitted as JSON records to support shipping into systems like Grafana.

## Metrics Interface

The metrics contract lives in `indexer/src/metrics/types.ts`:

- `increment(name, value?, labels?)`
- `gauge(name, value, labels?)`
- `histogram(name, value, labels?)`

A no-op implementation exists in `indexer/src/metrics/noop.ts`.

## Current Metric Hooks

Metrics are collected in a few places to establish a baseline:

- RPC latency and retries (`indexer/src/infra/rpc/viem.ts`).
- Cache hits, misses, evictions (`indexer/src/infra/cache/memory.ts`).
- Metadata resolve/fetch latency and failures (`indexer/src/infra/metadata/*`).

These hooks are intentionally lightweight and can be connected to a real metrics backend later.

## Cache Metrics

The in-memory cache maintains:

- `hits`, `misses`, `entries` counters.
- Per-namespace hit/miss metrics.
- Eviction counters and entry gauges.

This provides early visibility into cache effectiveness without external dependencies.
