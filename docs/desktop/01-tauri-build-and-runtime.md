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
yarn build:userland
yarn build:admin
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
  : Uses `@sveltejs/adapter-node` and produces web/server artifacts under `frontend/build-web`.

- `yarn build:userland`
  : Runs `scripts/build/build-frontend-target.mjs userland`.
  : Uses `@sveltejs/adapter-static` and writes browser userland static output to `frontend/dist-userland`.

- `yarn build:admin`
  : Runs `scripts/build/build-frontend-target.mjs admin`.
  : Uses `@sveltejs/adapter-static` and writes native admin static output to `frontend/dist`.

- `yarn build:desktop`
  : Alias for `yarn build:admin`.

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

- `beforeBuildCommand = "yarn build:admin && yarn build:userland && yarn build:runtime && yarn build:desktop-runtime-resources"`
- `frontendDist = "../frontend/dist"`

This ensures `yarn tauri build ...` always has:

1. desktop frontend static output
2. browser userland static output
3. backend/indexer runtime `.mjs` artifacts
4. staged runtime resources under `src-tauri/resources/runtime`

before Rust bundling starts.

## Build Helper Scripts

### `scripts/build/build-frontend-target.mjs`

Responsibilities:

- receives explicit target (`web`, `userland`, or `admin`; `desktop` remains legacy alias to `admin`)
- exports target via:
    - `FRONTEND_BUILD_TARGET`
    - `VITE_FRONTEND_BUILD_TARGET`
- runs frontend workspace build
- SvelteKit adapter selection is handled in `frontend/svelte.config.js`:
    - `FRONTEND_BUILD_TARGET=admin` -> `@sveltejs/adapter-static` (`frontend/dist`)
    - `FRONTEND_BUILD_TARGET=userland` -> `@sveltejs/adapter-static` (`frontend/dist-userland`)
    - `FRONTEND_BUILD_TARGET=web` -> `@sveltejs/adapter-node` (`frontend/build-web`)

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
    - `frontend/dist-userland/*`
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

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\network.artgod.desktop\config\.env`

Desktop-specific required keys:

- `DESKTOP_NATS_PORT`
- `DESKTOP_AUTO_START`
- `DESKTOP_RESTART_BACKOFF_MS`
- `USERLAND_UI_DIST_DIR`

Desktop-specific optional overrides:

- `DESKTOP_NODE_BIN` (defaults to bundled `runtime/node/node(.exe)`)
- `DESKTOP_NATS_BINARY_PATH` (defaults to bundled `runtime/nats/nats-server(.exe)`)
- `DESKTOP_RUNTIME_RESOURCES_DIR` (default `runtime`, resolved from app resource dir)
- `DESKTOP_NODE_PNP_CJS` (default `.pnp.cjs`, resolved from runtime resources dir)
- `DESKTOP_NODE_PNP_LOADER` (default `.pnp.loader.mjs`, resolved from runtime resources dir)

Core runtime keys are also validated (for backend/indexer startup), for example:

- `ARTGOD_DB_PATH`
- `USERLAND_UI_DIST_DIR`
- `RPC_URL`
- `WETH_ADDRESS`
- `SEAPORT_CONDUIT_CONTROLLER`

Desktop-first default path behavior:

- `ARTGOD_DB_PATH` defaults to `sqlite/main/db` and is resolved relative to app-data dir unless absolute.
- `USERLAND_UI_DIST_DIR` defaults to `frontend/userland` and is resolved relative to desktop runtime resources dir unless absolute.
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

Startup trigger:

1. Rust app setup initializes commands and logs startup, but does **not** auto-start supervisor work in `setup()`.
2. Frontend lifecycle orchestrator (`runtime/lifecycle/orchestrator.ts`) waits for Tauri bridge and invokes `runtime_auto_start`.
3. `runtime_auto_start` calls `RuntimeManager::auto_start`, which loads/validates desktop config and starts supervisor thread.

Supervisor startup order:

1. start bundled NATS process (`nats-server`)
2. wait for NATS port readiness
3. start backend artifact
4. wait for backend port readiness
5. start all indexer worker artifacts
6. wait for backend semantic readiness via `GET /health/runtime`
   : checks backend process + DB ping + NATS/JetStream jobs stream readiness details
   : NATS connectivity errors are fatal; "jobs stream not yet created" is reported as warning (`warn`) and does not block startup
7. only after semantic readiness succeeds, supervisor sets runtime status to `running`

If any step fails:

- already-started processes are stopped
- runtime enters restart flow with backoff
- stop requests interrupt startup waits immediately (port waits, semantic health waits, and backoff sleeps)

Frontend readiness behavior:

- admin runtime console is shown immediately on app mount (native WebView)
- lifecycle tab remains active during boot until lifecycle becomes `ready`
- lifecycle reaches `ready` only after lifecycle orchestrator backend readiness probe succeeds, not merely when runtime status becomes `running`
- admin UI does not execute userland collection/token route loads
- userland browser UI uses `backend-api.ts` directly against backend localhost origin (`/api/*`)
- runtime readiness in lifecycle orchestrator is event-first (`runtime-state-changed`) with a status reconciliation fallback poll during boot
- userland product UI is served by backend static hosting at `backend_http_base_url` and opened in system browser via admin UI/tray action

## Process Start Details

Node artifacts are launched with Yarn PnP hooks:

- `--require <.pnp.cjs>`
- `--experimental-loader <.pnp.loader.mjs>`

This is required for correct module resolution in packaged desktop mode.

## Shutdown and Restart Semantics

### Trigger Paths

Desktop stop is triggered by:

- explicit command (`runtime_stop`)
- tray `shutdown` menu item
- app `ExitRequested` event hook

Window close behavior:

- `CloseRequested` is prevented
- admin window is hidden
- runtime continues in background under tray control

### Stop Strategy

Supervisor stop behavior:

1. request graceful process stop (SIGTERM on Unix)
2. wait up to grace timeout (`10s`)
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

Admin runtime drawer process dropdown behavior:

- process list is sourced from:
  : explicit log file enumeration (`runtime_list_log_processes`) when hydrating runtime state
  : plus live `runtime-log` event process names as they appear
- this makes all existing process logs selectable even before supervisor transitions status to `running`

## Runtime Operations UI

Desktop UI is split into:

- admin UI (native Tauri WebView)
- userland UI (regular browser tab at backend localhost origin)

Admin UI mounts runtime operations view in root layout (`frontend/src/routes/+layout.svelte`):

- live runtime state (`runtime-state-changed` event)
- live log stream (`runtime-log` event)
- controls: start / stop / restart / preflight
- paths: config path and logs path with open actions
- action: `open ArtGod in browser` (opens userland UI in system browser)

Admin lifecycle UX is embedded in runtime operations (`lifecycle` tab):

- visible immediately on startup while lifecycle phase is not `ready`
- shows lifecycle events as single-line rows with bracket tokens (`[level] [code]`) for copy-friendly logs
- remains in admin UI after startup as historical lifecycle stream

Tauri commands used by desktop frontend runtime UI/state:

- `runtime_auto_start` (boot lifecycle orchestrator startup handshake)
- `runtime_start`
- `runtime_stop`
- `runtime_restart`
- `runtime_status`
- `runtime_preflight`
- `runtime_get_endpoints`
- `runtime_get_config_path`
- `runtime_get_logs_path`
- `runtime_get_logs_tail`
- `runtime_list_log_processes`
- `runtime_open_config_path`
- `runtime_open_logs_path`
- `runtime_open_userland_ui`

## CI Release Pipeline

Public release workflow:

- `.github/workflows/tauri-release.yml`
- `.github/workflows/tauri-repro-check.yml` (unsigned Linux reproducibility parity check)

Trigger:

- push tag `v*`

Build matrix:

- Linux x64 (`x86_64-unknown-linux-gnu`)
- Windows x64 (`x86_64-pc-windows-msvc`)
- macOS universal (`universal-apple-darwin`)

Outputs:

- bundle artifacts uploaded to GitHub Release
- `SHA256SUMS.txt`
- `SHA256SUMS.txt.asc`
- Linux detached signatures (`*.AppImage.asc`, `*.deb.asc`)
- build provenance attestation

Current state:

- Linux artifacts are GPG-signed (detached armor signatures).
- macOS DMG is code-signed, notarized, and stapled in CI.
- Windows NSIS/installer artifacts are Authenticode-signed in CI.

Release secrets expected by CI:

- Linux GPG:
    - `LINUX_GPG_PRIVATE_KEY_ASC`
    - `LINUX_GPG_PASSPHRASE`
    - `LINUX_GPG_KEY_ID`
    - optional: `LINUX_GPG_OWNERTRUST`
- macOS:
    - `APPLE_CERTIFICATE` (base64 `.p12`)
    - `APPLE_CERTIFICATE_PASSWORD`
    - `APPLE_SIGNING_IDENTITY`
    - `APPLE_API_KEY` (base64 `.p8`)
    - `APPLE_API_KEY_ID`
    - `APPLE_API_ISSUER`
- Windows:
    - `WINDOWS_CERT_PFX_B64`
    - `WINDOWS_CERT_PASSWORD`
    - optional: `WINDOWS_CERT_SHA1`
    - optional: `WINDOWS_TIMESTAMP_URL`

Consumer-side verification examples:

- Linux checksum + checksums signature:
    - `gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt`
    - `sha256sum -c SHA256SUMS.txt`
- Linux detached artifact signature:
    - `gpg --verify ArtGod-x.y.z.AppImage.asc ArtGod-x.y.z.AppImage`
    - `gpg --verify ArtGod-x.y.z.deb.asc ArtGod-x.y.z.deb`

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

- Startup request reaches terminal API failure (`api.request.fail.final`)
  : Current boot flow does not include an automatic background recovery probe. If dependencies recover after terminal failure, trigger a manual reload/restart to resume normal route loading.
