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
yarn build:web
yarn build:desktop
yarn build:runtime
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

- `yarn check:runtime-registry`
: Runs `scripts/build/check-runtime-registry.mjs`.
: Verifies runtime registry consistency across desktop build maps, supervisor mappings, dev launchers, and observability/metrics mappings.

- `yarn clean:build`
: Runs `scripts/build/clean-build-artifacts.mjs`.
: Removes dist and cache outputs across workspaces (`dist*`, `.vite`, `.vitest`, `.svelte-kit`, `src-tauri/target`).

## Tauri Build Hooking

`src-tauri/tauri.conf.json` contains:

- `beforeBuildCommand = "yarn build:desktop && yarn build:runtime"`
- `frontendDist = "../frontend/dist"`

This ensures `yarn tauri build ...` always has:

1. desktop frontend static output
2. backend/indexer runtime `.mjs` artifacts

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

These are what the desktop supervisor launches in production desktop mode.

## Desktop Runtime Config File

Desktop config is generated on first app launch in app-data:

- Linux: `~/.local/share/io.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/io.artgod.desktop/config/.env`
- Windows: `%APPDATA%\io.artgod.desktop\config\.env`

Desktop-specific required keys:

- `DESKTOP_WORKSPACE_ROOT`
- `DESKTOP_NODE_BIN`
- `DESKTOP_RUNTIME_DIR`
- `DESKTOP_NODE_PNP_CJS`
- `DESKTOP_NODE_PNP_LOADER`
- `DESKTOP_NATS_MODE` (`docker` or `binary`)
- `DESKTOP_NATS_PORT`
- `DESKTOP_AUTO_START`
- `DESKTOP_RESTART_BACKOFF_MS`

Core runtime keys are also validated (for backend/indexer startup), for example:

- `ARTGOD_DB_PATH`
- `RPC_URL`
- `WETH_ADDRESS`
- `SEAPORT_CONDUIT_CONTROLLER`

Important:

- if this file was generated before new desktop runtime keys were introduced, regenerate or update it manually
- desktop runtime sets `ARTGOD_ENV_FILE` for child processes, so backend/indexer read this desktop config path explicitly

## Supervisor Runtime Composition

Runtime composition code lives in:

- `src-tauri/src/runtime/config.rs`
- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/src/lib.rs`

Startup order:

1. start NATS process (docker container or binary)
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

For Docker NATS mode, cleanup includes best-effort:

- `docker rm -f <managed-container-name>`

This prevents stale container/port leaks between app runs.

### Restart Strategy

Runtime is fail-fast:

- if any core process exits unexpectedly, supervisor stops all and restarts the full stack
- status and last error are emitted to frontend via runtime events

## Logging

Supervisor captures stdout/stderr from each child process and writes:

- `<app-data>/logs/<process>.log`

It also emits log lines to frontend runtime event stream.

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
: Run `yarn build:runtime`.

- Stale dist/cache state
: Run `yarn clean:build`.

- Desktop config key errors on startup
: Check desktop app-data `.env` and required `DESKTOP_*` keys.

- Port already in use after abrupt stop
: Current supervisor includes graceful stop + forced cleanup; if interrupted externally, verify no stale container/process remains before restart.
