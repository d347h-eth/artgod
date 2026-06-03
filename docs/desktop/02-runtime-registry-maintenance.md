# Desktop Runtime Registry Maintenance

This document is a maintainer guide for adding/removing desktop-managed runtimes.

Goal: keep all explicit runtime lists/maps in sync across build, supervisor, dev launchers, and observability.

This now covers two runtime families:

- fail-fast core composition runtimes (`backend`, `indexer/*`, `nats`)
- wallet-bound trading bot runtimes (`trading/*`)

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
- trading bot artifact entrypoints (`entryPoints` object keys)

If a worker is missing here, no `dist-desktop` artifact is produced for desktop runtime mode.

### 2) Desktop Supervisor Launch Map

File:

- `src-tauri/src/runtime/process_registry.rs`
- `src-tauri/src/runtime/supervisor.rs`

What is explicit here:

- `BACKEND_ARTIFACT`
- `INDEXER_WORKERS` list of `(process_name, artifact_relative_path)`
- `BOT_RUNTIME_SPECS` list of wallet-bound bot process names, artifacts, and critical dependencies
- expected app-data log filenames are derived from the same registry so
  late-started wallet-bound bot logs exist before Alloy tails them

Supervisor uses these lists to spawn, monitor, and log runtime processes.

OpenSea indexer workers are still part of this registry and staged artifacts, but their launch is capability-gated by `OPENSEA_INTEGRATION_MODE` + `OPENSEA_API_KEY`. Keep registry membership separate from launch eligibility: removing a worker from the registry means it cannot run; disabling OpenSea means the supervisor intentionally skips that worker at startup.

If a worker is missing here, desktop app will not start it even if artifact exists.

### 3) Tauri Build Composition Hook

File:

- `src-tauri/tauri.conf.json`

What is explicit here:

- `beforeBuildCommand = "yarn build:admin && yarn build:userland && yarn build:runtime && yarn build:desktop-runtime-resources && yarn build:desktop-sidecars --profile release"`

This must continue to include runtime resource staging so artifacts are present in bundled resources before desktop packaging.
Staging must include both runtime artifacts and runtime dependencies:

- bundled Node runtime (`resources/runtime/node/node(.exe)`)
- bundled NATS runtime (`resources/runtime/nats/nats-server(.exe)`)
- Yarn runtime dependency data (`.yarn/cache`, `.yarn/unplugged`, `.yarn/install-state.gz`, `.pnp.cjs`, `.pnp.loader.mjs`)

### 4) Root Build Command Wiring

File:

- `package.json` (root)

What is explicit here:

- `build:runtime`
- `build:desktop-runtime-resources`
- `clean:build`
- root workspace list, which must include `trading` once wallet-bound bot runtimes exist

These commands are the stable interface used by Tauri build and developers.

### 5) Indexer Dev Runtime Script Registry

Files:

- `indexer/package.json` (`dev:*` scripts)
- `scripts/indexer-dev.sh` (`start_worker` list)

What is explicit here:

- dev command name per runtime
- dev launcher process names and startup list order

This is separate from Tauri production composition, but should stay aligned with runtime topology.

Trading bot runtimes do not currently have a parallel standalone dev launcher.
They are desktop-managed only.

### 6) Worker Identity + Metrics Port Mapping

Files:

- `indexer/src/runtime/*.ts` (worker string in APM/Metrics setup)
- `indexer/src/config/observability-env.ts` (`metrics.ports.*` map)
- `config/settings.manifest.toml` (source for matching `INDEXER_METRICS_PORT_*` vars)
- `.env.example` and `shared/config/generated-settings-defaults.ts` (generated from the settings manifest)
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

4. Ensure runtime resource staging includes the new artifact.
   : Validate `scripts/build/prepare-desktop-runtime-resources.mjs` copies `indexer/dist-desktop/*` (all workers are included by directory copy), stages bundled Node+NATS runtimes (`resources/runtime/node/node(.exe)`, `resources/runtime/nats/nats-server(.exe)`), and keeps Yarn runtime dependency data bundled (`.yarn/cache`, `.yarn/unplugged`, `.yarn/install-state.gz`, `.pnp.cjs`, `.pnp.loader.mjs`).

5. Add supervisor launch mapping.
   : Add `("indexer-foo-worker", "indexer/dist-desktop/foo-worker.mjs")` in `INDEXER_WORKERS`.

6. Add dev launcher wiring (optional but expected).
   : Add `start_worker "indexer-foo-worker" "dev:foo-worker"` in `scripts/indexer-dev.sh`.

7. Wire metrics config.
   : Add `metrics.ports.fooWorker` in `indexer/src/config/index.ts`.
   : Add env var parse and default port.

8. Wire observability scrape target.
   : Add target in `observability/prometheus/prometheus.yml` with `runtime: "foo-worker"` label.

9. Sync docs.
   : Update runtime lists/commands in `README.md`.
   : Update topology in `docs/indexer/00-overview.md`.
   : Update metrics ports in `docs/indexer/10-observability-and-metrics.md`.

10. Verify.
    : `yarn install --immutable`
    : `yarn build:runtime`
    : `yarn build:desktop-runtime-resources`
    : `yarn tauri build --no-bundle --ci`
    : Start desktop app and confirm process appears in runtime state/logs.
    : `up{job="artgod-indexer",runtime="foo-worker"}` in Prometheus/Grafana.

When adding a new trading bot runtime (example `foo-bot`):

1. Add runtime entrypoint.
   : Create `trading/src/runtime/foo-bot-runtime.ts`.

2. Add artifact build entrypoint.
   : Add `foo-bot-runtime` in `scripts/build/build-runtime-artifacts.mjs`.

3. Ensure runtime resource staging includes the new artifact.
   : Validate `scripts/build/prepare-desktop-runtime-resources.mjs` copies `trading/dist-desktop/*`.

4. Add supervisor bot spec.
   : Add the process name, artifact path, and critical dependency list in `src-tauri/src/runtime/bot_runtime.rs`.
   : The app-data log file is provisioned automatically from `BOT_RUNTIME_SPECS`.

5. Sync admin/UI contracts if needed.
   : Update `src-tauri/src/wallet/tauri/bot_commands.rs` and `frontend/src/lib/admin/bots/**` if the new bot kind must be operator-visible.

6. Sync docs.
   : Update `README.md` and desktop wallet/bot docs if the operator model changes.

7. Verify.
   : `yarn install --immutable`
   : `yarn build:runtime`
   : `yarn build:desktop-runtime-resources`
   : `yarn tauri build --no-bundle --ci`
   : Start desktop app and confirm the bot can be assigned, unlocked, started, and stopped without secrets leaking to env or CLI.

## Remove Runtime Checklist

When removing a runtime:

1. Remove runtime entrypoint and references in runtime code.
2. Remove `dev:*` script (`indexer/package.json`).
3. Remove dev launcher entry (`scripts/indexer-dev.sh`).
4. Remove artifact entrypoint (`scripts/build/build-runtime-artifacts.mjs`).
5. Keep runtime resource staging aligned (`scripts/build/prepare-desktop-runtime-resources.mjs` copies `indexer/dist-desktop/*`).
6. Remove supervisor mapping (`INDEXER_WORKERS`).
7. Remove metrics port mapping and env var references.
8. Remove Prometheus scrape target.
9. Update README and indexer docs runtime lists.
10. Verify no stale references via grep.

## Quick Drift Audit Commands

Use these checks before merging runtime topology changes:

```sh
yarn config:check
yarn check:runtime-registry
rg -n "dev:.*worker" indexer/package.json
rg -n "start_worker" scripts/indexer-dev.sh
rg -n "entryPoints|worker" scripts/build/build-runtime-artifacts.mjs
rg -n "INDEXER_WORKERS|BACKEND_ARTIFACT" src-tauri/src/runtime/process_registry.rs
rg -n "INDEXER_METRICS_PORT_|metrics\\.ports" indexer/src/config/observability-env.ts config/settings.manifest.toml .env.example
rg -n "runtime:|946" observability/prometheus/prometheus.yml
```

`yarn config:check` guards generated settings artifacts; `yarn check:runtime-registry` is the canonical automated guard for runtime topology and is also run in CI (`.github/workflows/tauri-build-check.yml`).

## Current Limitation

Runtime registry is duplicated by design across:

- build map
- supervisor map
- dev launcher map
- metrics/observability maps

This keeps each layer explicit, but requires disciplined updates. If runtime churn grows, consider introducing one canonical runtime manifest and generating these lists from it.
