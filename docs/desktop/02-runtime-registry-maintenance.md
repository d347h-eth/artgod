# Desktop Runtime Registry Maintenance

This document is a maintainer guide for adding/removing desktop-managed runtimes.

Goal: keep all explicit runtime lists/maps in sync across build, supervisor, dev launchers, and observability.

## Why This Exists

Runtime composition is currently explicit, not auto-discovered.

That is intentional for clarity and fail-fast behavior, but it means adding or removing a worker requires touching multiple files. If one list is missed, desktop startup/build/monitoring can drift.

## Runtime Registry Touchpoints

Treat the following files as the full runtime registry surface.

### 1) Production Runtime Artifact Build Map

File:

- `scripts/build/build-runtime-artifacts.mjs`

What is explicit here:

- backend runtime entrypoint (`server`)
- indexer worker artifact entrypoints (`entryPoints` object keys)

If a worker is missing here, no `dist-desktop` artifact is produced for desktop runtime mode.

### 2) Desktop Supervisor Launch Map

File:

- `src-tauri/src/runtime/supervisor.rs`

What is explicit here:

- `BACKEND_ARTIFACT`
- `INDEXER_WORKERS` list of `(process_name, artifact_relative_path)`

Supervisor uses this list to spawn, monitor, and log worker processes.

If a worker is missing here, desktop app will not start it even if artifact exists.

### 3) Tauri Build Composition Hook

File:

- `src-tauri/tauri.conf.json`

What is explicit here:

- `beforeBuildCommand = "yarn build:desktop && yarn build:runtime"`

This must continue to include `build:runtime` so runtime artifacts are present before desktop packaging.

### 4) Root Build Command Wiring

File:

- `package.json` (root)

What is explicit here:

- `build:runtime`
- `clean:build`

These commands are the stable interface used by Tauri build and developers.

### 5) Indexer Dev Runtime Script Registry

Files:

- `indexer/package.json` (`dev:*` scripts)
- `scripts/indexer-dev.sh` (`start_worker` list)

What is explicit here:

- dev command name per runtime
- dev launcher process names and startup list order

This is separate from Tauri production composition, but should stay aligned with runtime topology.

### 6) Worker Identity + Metrics Port Mapping

Files:

- `indexer/src/runtime/*.ts` (worker string in APM/Metrics setup)
- `indexer/src/config/index.ts` (`metrics.ports.*` map)
- `.env.example` (matching `METRICS_PORT_*` vars)
- `observability/prometheus/prometheus.yml` (static scrape targets + runtime labels)

What is explicit here:

- runtime worker identifier strings
- metric port assignment per runtime
- Prometheus target list

If this drifts, metrics dashboards and scrape health will be incomplete even if runtime is running.

### 7) Human Runtime Topology Docs

Files:

- `README.md` (runtime list + common commands)
- `docs/indexer/00-overview.md` (runtime topology)
- `docs/indexer/10-observability-and-metrics.md` (metrics port map)

These are not runtime code, but should be updated in the same PR to prevent operator confusion.

## Add Runtime Checklist

When adding a new indexer runtime (example `foo-worker`):

1. Add runtime entrypoint.
: Create `indexer/src/runtime/foo-worker.ts` with explicit `worker` identity for metrics/APM.

2. Add dev script.
: Add `dev:foo-worker` in `indexer/package.json`.

3. Add artifact build entrypoint.
: Add `foo-worker` in `scripts/build/build-runtime-artifacts.mjs` `entryPoints`.

4. Add supervisor launch mapping.
: Add `("indexer-foo-worker", "indexer/dist-desktop/foo-worker.mjs")` in `INDEXER_WORKERS`.

5. Add dev launcher wiring (optional but expected).
: Add `start_worker "indexer-foo-worker" "dev:foo-worker"` in `scripts/indexer-dev.sh`.

6. Wire metrics config.
: Add `metrics.ports.fooWorker` in `indexer/src/config/index.ts`.
: Add env var parse and default port.

7. Wire observability scrape target.
: Add target in `observability/prometheus/prometheus.yml` with `runtime: "foo-worker"` label.

8. Sync docs.
: Update runtime lists/commands in `README.md`.
: Update topology in `docs/indexer/00-overview.md`.
: Update metrics ports in `docs/indexer/10-observability-and-metrics.md`.

9. Verify.
: `yarn build:runtime`
: `yarn tauri build --no-bundle --ci`
: Start desktop app and confirm process appears in runtime state/logs.
: `up{job="artgod-indexer",runtime="foo-worker"}` in Prometheus/Grafana.

## Remove Runtime Checklist

When removing a runtime:

1. Remove runtime entrypoint and references in runtime code.
2. Remove `dev:*` script (`indexer/package.json`).
3. Remove dev launcher entry (`scripts/indexer-dev.sh`).
4. Remove artifact entrypoint (`scripts/build/build-runtime-artifacts.mjs`).
5. Remove supervisor mapping (`INDEXER_WORKERS`).
6. Remove metrics port mapping and env var references.
7. Remove Prometheus scrape target.
8. Update README and indexer docs runtime lists.
9. Verify no stale references via grep.

## Quick Drift Audit Commands

Use these checks before merging runtime topology changes:

```sh
rg -n "dev:.*worker" indexer/package.json
rg -n "start_worker" scripts/indexer-dev.sh
rg -n "entryPoints|worker" scripts/build/build-runtime-artifacts.mjs
rg -n "INDEXER_WORKERS|BACKEND_ARTIFACT" src-tauri/src/runtime/supervisor.rs
rg -n "METRICS_PORT_|metrics\\.ports" indexer/src/config/index.ts .env.example
rg -n "runtime:|946" observability/prometheus/prometheus.yml
```

## Current Limitation

Runtime registry is duplicated by design across:

- build map
- supervisor map
- dev launcher map
- metrics/observability maps

This keeps each layer explicit, but requires disciplined updates. If runtime churn grows, consider introducing one canonical runtime manifest and generating these lists from it.

