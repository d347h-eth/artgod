# Tauri Build and Runtime Pipeline

This document describes the current desktop pipeline end-to-end:

1. how artifacts are built
2. how Tauri assembles the app
3. how the desktop runtime supervisor launches backend/indexer/NATS
4. how shutdown, restart, and cleanup behave
5. how release bundles are produced in CI

It is the canonical technical reference for desktop composition in this repository.

For add/remove runtime registry maintenance, see:

- `docs/desktop/02-runtime-registry-maintenance.md`

## Scope and Goals

The desktop build/runtime pipeline is designed to:

- keep frontend/backend/indexer in one local executable wrapper
- keep runtime behavior explicit and fail-fast
- avoid relying on development launch commands in production desktop mode
- make release builds reproducible in public CI

The desktop shell does not replace backend/indexer logic. It orchestrates existing runtimes.

## Build Commands

Root build/helper commands:

```sh
yarn install --immutable
yarn build:web
yarn build:desktop
yarn build:runtime
yarn build:desktop-runtime-resources
yarn check:runtime-registry
yarn clean:build
yarn tauri build --no-bundle --ci
yarn tauri build --debug --no-bundle --ci
```

What each command does:

- `yarn build:web`
  : Runs `scripts/build/build-frontend-target.mjs web`.
  : Produces standard frontend artifacts for web flow.

- `yarn build:desktop`
  : Runs `scripts/build/build-frontend-target.mjs desktop`.
  : Builds frontend, then exports desktop static `frontend/dist` via `export-tauri-frontend.mjs`.

- `yarn build:runtime`
  : Runs `scripts/build/build-runtime-artifacts.mjs`.
  : Produces backend/indexer runtime artifacts under workspace-local `dist-desktop` folders.

- `yarn build:desktop-runtime-resources`
  : Runs `scripts/build/prepare-desktop-runtime-resources.mjs`.
  : Copies runtime artifacts plus Yarn runtime dependency data into `src-tauri/resources/runtime` for bundling:
    - `.yarn/cache`
    - `.yarn/unplugged`
    - `.yarn/install-state.gz`
    - `.pnp.cjs`
    - `.pnp.loader.mjs`

- `yarn check:runtime-registry`
  : Runs `scripts/build/check-runtime-registry.mjs`.
  : Verifies runtime registry consistency across desktop build maps, supervisor mappings, dev launchers, and observability/metrics mappings.

- `yarn clean:build`
  : Runs `scripts/build/clean-build-artifacts.mjs`.
  : Removes dist and cache outputs across workspaces (`dist*`, `.vite`, `.vitest`, `.svelte-kit`, `src-tauri/target`, `src-tauri/resources/runtime`).

## Tauri Build Hooking

`src-tauri/tauri.conf.json` contains:

- `beforeBuildCommand = "yarn build:desktop && yarn build:runtime && yarn build:desktop-runtime-resources"`
- `frontendDist = "../frontend/dist"`

This ensures `yarn tauri build ...` always has:

1. desktop frontend static output
2. backend/indexer runtime `.mjs` artifacts
3. staged runtime resources under `src-tauri/resources/runtime`

before Rust bundling starts.

## Build Helper Scripts

### `scripts/build/build-frontend-target.mjs`

Responsibilities:

- receives explicit target (`web` or `desktop`)
- exports target via:
    - `FRONTEND_BUILD_TARGET`
    - `VITE_FRONTEND_BUILD_TARGET`
- runs frontend workspace build
- for `desktop` target, runs `scripts/build/export-tauri-frontend.mjs`

### `scripts/build/export-tauri-frontend.mjs`

Responsibilities:

- boots SvelteKit server output (`.svelte-kit/output/server`)
- renders root HTML once
- copies client assets to `frontend/dist`
- writes `index.html` and `404.html`

Result:

- Tauri serves a static desktop shell from `frontend/dist`.

### `scripts/build/build-runtime-artifacts.mjs`

Responsibilities:

- cleans old runtime outputs
- builds backend/indexer runtime entrypoints with `esbuild`
- writes:
    - `backend/dist-desktop/server.mjs`
    - `indexer/dist-desktop/*.mjs` (all worker entrypoints)

Current build strategy details:

- `bundle: true`, `format: "esm"`, `platform: "node"`
- `better-sqlite3` is externalized
- Node `require` shim banner is injected for CJS dependencies bundled into ESM output
- explicit `tsconfigRaw` is provided so runtime build does not depend on frontend `.svelte-kit` TS config state

### `scripts/build/prepare-desktop-runtime-resources.mjs`

Responsibilities:

- stages runtime resources for Tauri bundling under `src-tauri/resources/runtime`
- downloads/verifies the Node distribution for the target platform and stages bundled Node under `src-tauri/resources/runtime/node`
  : source of truth for Node version is `package.json` `engines.node`
  : download target is inferred from OS/arch or forced with `DESKTOP_NODE_DIST_TARGET`
  : downloaded archives are cached in `.cache/desktop-node-runtime`
- downloads/verifies the NATS server distribution for the target platform and stages bundled NATS under `src-tauri/resources/runtime/nats`
  : source of truth for NATS version is `DESKTOP_NATS_VERSION` build env (default `2.10.17`)
  : download target is inferred from OS/arch or forced with `DESKTOP_NATS_DIST_TARGET`
  : downloaded archives are cached in `.cache/desktop-nats-runtime`
- copies:
    - `backend/dist-desktop/*`
    - `indexer/dist-desktop/*`
    - `node/node` or `node/node.exe`
    - `nats/nats-server` or `nats/nats-server.exe`
    - `.yarn/cache/*`
    - `.yarn/unplugged/*`
    - `.yarn/install-state.gz`
    - `.pnp.cjs`
    - `.pnp.loader.mjs`
    - `fixtures/opensea-event-payloads/*` (desktop-first default path)

### `scripts/build/clean-build-artifacts.mjs`

Responsibilities:

- clears stale build/caches from root and all workspaces
- keeps cleanup centralized, deterministic, and cross-platform

## Frontend TS Config Sync

`frontend/package.json` build script is:

```sh
svelte-kit sync && vite build
```

Reason:

- frontend `tsconfig.json` extends `.svelte-kit/tsconfig.json`
- `yarn clean:build` removes `.svelte-kit`
- running `svelte-kit sync` before `vite build` prevents transient missing-base-tsconfig warnings on clean builds

## Runtime Artifact Layout

Produced runtime artifacts:

- `backend/dist-desktop/server.mjs`
- `indexer/dist-desktop/scheduler-worker.mjs`
- `indexer/dist-desktop/sync-worker.mjs`
- `indexer/dist-desktop/reorg-worker.mjs`
- `indexer/dist-desktop/domain-worker.mjs`
- `indexer/dist-desktop/bootstrap-worker.mjs`
- `indexer/dist-desktop/offchain-ingest-worker.mjs`
- `indexer/dist-desktop/opensea-stream-worker.mjs`
- `indexer/dist-desktop/dead-letter-worker.mjs`

During Tauri build these artifacts are copied to `src-tauri/resources/runtime/...` and that staged tree is bundled into the desktop app resources.

## Desktop Runtime Config File

Desktop config is generated on first app launch in app-data:

- Linux: `~/.local/share/io.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/io.artgod.desktop/config/.env`
- Windows: `%APPDATA%\io.artgod.desktop\config\.env`

Desktop-specific required keys:

- `DESKTOP_NATS_PORT`
- `DESKTOP_AUTO_START`
- `DESKTOP_RESTART_BACKOFF_MS`

Desktop-specific optional overrides:

- `DESKTOP_NODE_BIN` (defaults to bundled `runtime/node/node(.exe)`)
- `DESKTOP_NATS_BINARY_PATH` (defaults to bundled `runtime/nats/nats-server(.exe)`)
- `DESKTOP_RUNTIME_RESOURCES_DIR` (default `runtime`, resolved from app resource dir)
- `DESKTOP_NODE_PNP_CJS` (default `.pnp.cjs`, resolved from runtime resources dir)
- `DESKTOP_NODE_PNP_LOADER` (default `.pnp.loader.mjs`, resolved from runtime resources dir)

Core runtime keys are also validated (for backend/indexer startup), for example:

- `ARTGOD_DB_PATH`
- `RPC_URL`
- `WETH_ADDRESS`
- `SEAPORT_CONDUIT_CONTROLLER`

Desktop-first default path behavior:

- `ARTGOD_DB_PATH` defaults to `sqlite/main/db` and is resolved relative to app-data dir unless absolute.
- `OPENSEA_FIXTURES_DIR` defaults to `fixtures/opensea-event-payloads` and is resolved relative to desktop runtime resources dir unless absolute.

Important:

- if this file was generated before new desktop runtime keys were introduced, regenerate or update it manually
- desktop runtime sets `ARTGOD_ENV_FILE` for child processes, so backend/indexer read this desktop config path explicitly
- runtime artifact paths are resolved from bundled app resources, not from a workspace root path

## Supervisor Runtime Composition

Runtime composition code lives in:

- `src-tauri/src/runtime/config.rs`
- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/src/lib.rs`

Startup order:

1. start bundled NATS process (`nats-server`)
2. wait for NATS port readiness
3. start backend artifact
4. wait for backend port readiness
5. start all indexer worker artifacts

If any step fails:

- already-started processes are stopped
- runtime enters restart flow with backoff

## Process Start Details

Node artifacts are launched with Yarn PnP hooks:

- `--require <.pnp.cjs>`
- `--experimental-loader <.pnp.loader.mjs>`

This is required for correct module resolution in packaged desktop mode.

## Shutdown and Restart Semantics

### Trigger Paths

Desktop stop is triggered by:

- explicit command (`runtime_stop`)
- window close request hook
- app `ExitRequested` event hook

### Stop Strategy

Supervisor stop behavior:

1. request graceful process stop (SIGTERM on Unix)
2. wait up to grace timeout (`5s`)
3. force kill remaining processes if still running
4. join output threads
5. run cleanup hooks

### Restart Strategy

Runtime is fail-fast:

- if any core process exits unexpectedly, supervisor stops all and restarts the full stack
- status and last error are emitted to frontend via runtime events

## Logging

Supervisor captures stdout/stderr from each child process and writes:

- `<app-data>/logs/<process>.log`

It also emits log lines to frontend runtime event stream.

## Runtime Operations UI

Desktop frontend now includes a global runtime drawer mounted in root layout (`frontend/src/routes/+layout.svelte`):

- live runtime state (`runtime-state-changed` event)
- live log stream (`runtime-log` event)
- controls: start / stop / restart / preflight
- paths: config path and logs path with open actions

Tauri commands used by the drawer:

- `runtime_start`
- `runtime_stop`
- `runtime_restart`
- `runtime_status`
- `runtime_preflight`
- `runtime_get_endpoints`
- `runtime_get_config_path`
- `runtime_get_logs_path`
- `runtime_get_logs_tail`
- `runtime_open_config_path`
- `runtime_open_logs_path`

## CI Release Pipeline

Public release workflow:

- `.github/workflows/tauri-release.yml`

Trigger:

- push tag `v*`

Build matrix:

- Linux x64 (`x86_64-unknown-linux-gnu`)
- Windows x64 (`x86_64-pc-windows-msvc`)
- macOS universal (`universal-apple-darwin`)

Outputs:

- bundle artifacts uploaded to GitHub Release
- `SHA256SUMS.txt`
- build provenance attestation

Current state:

- release is unsigned (no code signing/notarization yet)

## Troubleshooting

Common issues and checks:

- Runtime artifacts missing
  : Run `yarn install --immutable && yarn build:runtime && yarn build:desktop-runtime-resources`.

- Stale dist/cache state
  : Run `yarn clean:build`.

- Desktop config key errors on startup
  : Check desktop app-data `.env` and required `DESKTOP_*` keys.

- Port already in use after abrupt stop
  : Current supervisor includes graceful stop + forced cleanup; if interrupted externally, verify no stale `nats-server`/runtime process remains before restart.
