# Tauri Build and Runtime Pipeline

This document describes the current desktop pipeline end-to-end:

1. how artifacts are built
2. how Tauri assembles the app
3. how the desktop runtime supervisor launches backend/indexer/NATS
4. how shutdown, restart, and cleanup behave
5. how release bundles are produced in CI

It is the canonical technical reference for desktop composition in this repository.

Project versioning is documented centrally in `README.md` under `Versioning`.
For desktop releases, keep the release tag aligned with the root `package.json` version (`v<root-version>`) and run `yarn sync:version` before building or publishing release artifacts.

For add/remove runtime registry maintenance, see:

- `docs/desktop/02-runtime-registry-maintenance.md`

For desktop wallet custody, native secret prompts, and bot unlock policy, see:

- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`

For deferred local runtime identity and browser trust-store work, see:

- `docs/progress/desktop/02-local-runtime-identity-and-browser-trust.md`

## Scope and Goals

The desktop build/runtime pipeline is designed to:

- keep frontend/backend/indexer/trading in one local executable wrapper
- keep core-composition runtime behavior explicit and fail-fast
- avoid relying on development launch commands in production desktop mode
- make release builds reproducible in public CI

The desktop shell does not replace backend/indexer/trading logic. It orchestrates existing runtimes.

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
yarn build:desktop-sidecars --profile release
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
  : Produces backend/indexer/trading runtime artifacts under workspace-local `dist-desktop` folders.

- `yarn build:desktop-runtime-resources`
  : Runs `scripts/build/prepare-desktop-runtime-resources.mjs`.
  : Copies runtime artifacts plus Yarn runtime dependency data into `src-tauri/resources/runtime` for bundling:
    - `backend/dist-desktop/*`
    - `indexer/dist-desktop/*`
    - `trading/dist-desktop/*`
    - `.yarn/cache`
    - `.yarn/unplugged`
    - `.yarn/install-state.gz`
    - `.pnp.cjs`
    - `.pnp.loader.mjs`

- `yarn build:desktop-sidecars --profile release`
  : Runs `scripts/build/prepare-desktop-sidecars.mjs`.
  : Builds the native secret-prompt sidecar and stages the target-specific binary under `src-tauri/binaries`.

- `yarn check:runtime-registry`
  : Runs `scripts/build/check-runtime-registry.mjs`.
  : Verifies runtime registry consistency across desktop build maps, supervisor mappings, dev launchers, and observability/metrics mappings.

- `yarn clean:build`
  : Runs `scripts/build/clean-build-artifacts.mjs`.
  : Removes dist and cache outputs across workspaces (`dist*`, `.vite`, `.vitest`, `.svelte-kit`, `src-tauri/target`, `src-tauri/resources/runtime`, `src-tauri/binaries`, sidecar crate `target/*`).

## Tauri Build Hooking

`src-tauri/tauri.conf.json` contains:

- `beforeDevCommand = "yarn build:desktop-sidecars --profile debug && node ./scripts/build/dev-frontend-target.mjs admin"`
- `beforeBuildCommand = "yarn build:admin && yarn build:userland && yarn build:runtime && yarn build:desktop-runtime-resources && yarn build:desktop-sidecars --profile release"`
- `frontendDist = "../frontend/dist"`

This ensures `yarn tauri build ...` always has:

1. desktop frontend static output
2. browser userland static output
3. backend/indexer runtime `.mjs` artifacts
4. staged runtime resources under `src-tauri/resources/runtime`
5. staged native sidecar binaries under `src-tauri/binaries`

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
- builds backend/indexer/trading runtime entrypoints with `esbuild`
- writes:
    - `backend/dist-desktop/server.mjs`
    - `indexer/dist-desktop/*.mjs` (all worker entrypoints)
    - `trading/dist-desktop/*.mjs` (wallet-bound bot runtimes)

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
    - `trading/dist-desktop/*`
    - `node/node` or `node/node.exe`
    - `nats/nats-server` or `nats/nats-server.exe`
    - `.yarn/cache/*`
    - `.yarn/unplugged/*`
    - `.yarn/install-state.gz`
    - `.pnp.cjs`
    - `.pnp.loader.mjs`

### `scripts/build/prepare-desktop-sidecars.mjs`

Responsibilities:

- builds the native secret-prompt sidecar crate for the active target triple
- stages the built binary into `src-tauri/binaries/artgod-secret-prompt-<target-triple>(.exe)`
- keeps sidecar build output separate from the main `src-tauri/target` tree by using `src-tauri/target/sidecars`

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
- `indexer/dist-desktop/collection-extension-worker.mjs`
- `indexer/dist-desktop/offchain-ingest-worker.mjs`
- `indexer/dist-desktop/opensea-stream-worker.mjs`
- `indexer/dist-desktop/opensea-bootstrap-worker.mjs`
- `indexer/dist-desktop/opensea-reconcile-worker.mjs`
- `indexer/dist-desktop/opensea-reconcile-scheduler-worker.mjs`
- `indexer/dist-desktop/dead-letter-worker.mjs`
- `trading/dist-desktop/bidding-bot-runtime.mjs`
- `trading/dist-desktop/sniping-bot-runtime.mjs`

During Tauri build these artifacts are copied to `src-tauri/resources/runtime/...` and that staged tree is bundled into the desktop app resources.

Produced sidecar artifacts:

- `src-tauri/binaries/artgod-secret-prompt-<target-triple>(.exe)`

During Tauri build the sidecar is bundled through `bundle.externalBin` and invoked through Tauri's sidecar mechanism.

## Desktop Runtime Config Store

Desktop configuration is Admin-managed in app-data. The Rust app creates config/log directories during setup, but it does not create a runnable `.env` or start the supervisor until the operator chooses a launch path in Admin UI.

Versioned Admin settings file:

- Linux: `~/.local/share/network.artgod.desktop/config/settings.json`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/settings.json`
- Windows: `%APPDATA%\network.artgod.desktop\config\settings.json`

Rendered runtime env file:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\network.artgod.desktop\config\.env`

The settings manifest at `config/settings.manifest.toml` is the embedded Admin schema/default source. The settings file stores only operator overrides plus desktop metadata; it is not a full default snapshot. The rendered `.env` remains the startup contract for backend/indexer/trading child processes and is regenerated from effective manifest defaults plus overrides when Admin defaults are applied or configuration is saved. A stale `.env` without `settings.json` is not treated as configured and cannot drive supervisor auto-start. See `docs/desktop/04-settings-manifest-process.md` for the manifest generation and drift-control process.

Desktop-specific required keys:

- `DESKTOP_AUTO_START` (rendered from the Admin `autostart infra` checkbox)
- `DESKTOP_RESTART_BACKOFF_MS`
- `USERLAND_UI_DIST_DIR`

Desktop-specific optional overrides:

- `DESKTOP_NODE_BIN` (defaults to bundled `runtime/node/node(.exe)`)
- `DESKTOP_NATS_BINARY_PATH` (defaults to bundled `runtime/nats/nats-server(.exe)`)
  : JetStream storage is not left to the NATS default temp path. The desktop supervisor always starts bundled NATS with its store root at `<app-data>/nats`; JetStream files live under the NATS-created `jetstream` child.
- `DESKTOP_RUNTIME_RESOURCES_DIR` (default `runtime`, resolved from app resource dir)
- `DESKTOP_NODE_PNP_CJS` (default `.pnp.cjs`, resolved from runtime resources dir)
- `DESKTOP_NODE_PNP_LOADER` (default `.pnp.loader.mjs`, resolved from runtime resources dir)

Desktop-specific wallet/bot keys:

- `DESKTOP_WALLET_STORE_DIR` (defaults to `wallets`, resolved relative to app-data dir unless absolute)
- `DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS` (required; core runtime must remain healthy for this long before a bot unlock prompt is shown)

Trading bot runtime keys:

- `OPENSEA_STREAM_SECRET_KEY` (bot stream lane; separate from indexer `OPENSEA_API_KEY`)
- `OPENSEA_BIDDING_SECRET_KEY` (bot order placement/cancellation lane)
- `OPENSEA_SNAPSHOT_SECRET_KEY` (bot collection-offer snapshot polling lane)
- `BIDDING_WETH_ALLOWANCE_ETH` (static startup WETH approval target for the OpenSea conduit, in Ether units; `0` skips startup approval)
- `BIDDING_TX_MIN_PRIORITY_FEE_GWEI`, `BIDDING_TX_FEE_HISTORY_BLOCKS`, `BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE`, `BIDDING_TX_BASE_FEE_MULTIPLIER`, `BIDDING_TX_MAX_FEE_GWEI`, and `BIDDING_TX_PENDING_NONCE_POLICY` (bot-owned EIP-1559 fee and nonce guard policy for onchain transactions)
- `BIDDING_COMMAND_POLL_MS`, `BIDDING_COMMAND_BATCH_SIZE`, `BIDDING_COMMAND_MAX_ATTEMPTS`, and `BIDDING_COMMAND_CLAIM_TIMEOUT_MS` (DB Outbox recovery scan and retry policy for live job reconciliation)
- `BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS` (minimum interval between bot snapshot bid-book projections per collection)
- `BIDDING_*` tuning keys for dry-run mode, poll intervals, bootstrap concurrency, offer expiration, snapshot cadence, and trait-refresh maps

OpenSea capability keys:

- `OPENSEA_INTEGRATION_MODE=auto|enabled|disabled` controls whether OpenSea indexer workers and OpenSea-dependent bot starts are allowed.
- `OPENSEA_API_KEY` enables OpenSea integration in `auto` mode. In `enabled` mode it is mandatory and missing config fails desktop runtime startup.
- With `auto` and no `OPENSEA_API_KEY`, desktop startup continues; the supervisor skips OpenSea indexer workers, backend/userland report OpenSea disabled, and Admin bots show the disabled reason instead of starting.
- Bidding additionally requires `OPENSEA_STREAM_SECRET_KEY`, `OPENSEA_BIDDING_SECRET_KEY`, `OPENSEA_SNAPSHOT_SECRET_KEY`, and `BIDDING_ENABLED=true`.

Core runtime keys are also validated (for backend/indexer startup), for example:

- `ARTGOD_DB_PATH`
- `USERLAND_UI_DIST_DIR`
- `RPC_URL_LIST` (JSON array of weighted HTTP JSON-RPC endpoints)
- `NATS_URL` (must include full host:port, for example `nats://127.0.0.1:42720`)
- `WETH_ADDRESS`
- `SEAPORT_CONDUIT_CONTROLLER`
- observability keys use the canonical desktop/runtime names: `OBSERVABILITY_OTLP_HTTP_URL`, `OBSERVABILITY_PYROSCOPE_URL`, `BACKEND_METRICS_*`, `BACKEND_APM_*`, `INDEXER_METRICS_*`, and `INDEXER_APM_*`

Desktop-first default path behavior:

- `ARTGOD_DB_PATH` defaults to `sqlite/main/db` and is resolved relative to app-data dir unless absolute.
- `USERLAND_UI_DIST_DIR` defaults to `frontend/userland` and is resolved relative to desktop runtime resources dir unless absolute.
- bidding jobs are loaded from the ArtGod SQLite database.
- bidding bot heartbeat is written to SQLite as non-secret runtime state so backend reads can choose between competitive bot snapshots and normal orders fallback.

Important:

- if `settings.json` has no override for a current manifest key, `.env` rendering uses the manifest default for that key without rewriting the settings file during startup
- resetting defaults clears stored overrides instead of writing all manifest defaults into `settings.json`
- desktop runtime sets `ARTGOD_ENV_FILE` for child processes, so backend/indexer read this desktop config path explicitly
- runtime artifact paths are resolved from bundled app resources, not from a workspace root path

Startup-critical config remains env-file based at the child-process boundary. Do not move supervisor bootstrap config into the main SQLite database until Rust-owned startup and TS migrations have a shared ordering contract; the backend/indexer still own DB migrations. The Admin settings JSON is Rust-owned app-data, and the rendered `.env` must stay sufficient to start NATS, backend, indexer, and userland.

## Supervisor Runtime Composition

Runtime composition code lives in:

- `src-tauri/src/runtime/config.rs`
- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/src/lib.rs`

Startup trigger:

1. Rust app setup initializes commands and logs startup, but does **not** auto-start supervisor work in `setup()`.
2. Frontend lifecycle orchestrator (`runtime/lifecycle/orchestrator.ts`) waits for Tauri bridge and invokes `runtime_auto_start`.
3. `runtime_auto_start` calls `RuntimeManager::auto_start`, which checks Admin configuration state.
4. If no settings exist, or if `autostart infra` is disabled, runtime remains cleanly `stopped` and the Admin header action sequence guides `config` -> `start infra` -> `enter the userland`.
5. If `autostart infra` is enabled, Rust renders/loads the desktop `.env`, validates runtime config, and starts the supervisor thread.

Supervisor startup order:

1. start bundled NATS process (`nats-server`)
2. wait for NATS port readiness
3. start backend artifact
4. wait for backend port readiness
5. start enabled indexer worker artifacts; OpenSea workers are skipped when the resolved OpenSea capability is disabled
6. wait for backend semantic readiness via `GET /health/runtime`
   : checks backend process + DB ping + NATS/JetStream jobs stream readiness details
   : NATS connectivity errors are fatal; "jobs stream not yet created" is reported as warning (`warn`) and does not block startup
7. only after semantic readiness succeeds, supervisor sets runtime status to `running`

Wallet-bound bot runtimes are not part of the startup order above.
They stay independently managed and start only after explicit admin action, dependency stabilization, native unlock, and one-shot stdin secret handoff.
During long bidder warmup, bots move from `starting` to `bootstrapping`; the supervisor treats that as a live runtime phase and expects periodic bootstrap progress before final `running`.

If any step fails:

- already-started processes are stopped
- runtime enters restart flow with backoff
- stop requests interrupt startup waits immediately (port waits, semantic health waits, and backoff sleeps)

Frontend readiness behavior:

- admin shell is shown immediately on app mount (native WebView), with no tab active by default
- system tab exposes the lifecycle stream while the header action sequence remains the primary launch path
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

Core composition is fail-fast:

- if any core process exits unexpectedly, supervisor stops all and restarts the full stack
- status and last error are emitted to frontend via runtime events

Wallet-bound bot runtimes use separate restart semantics:

- a bot crash does not restart the core composition
- a bot stops if one of its declared critical dependencies becomes unhealthy
- a bot restart always returns to a locked state and requires a fresh native unlock prompt

## Logging

Supervisor captures stdout/stderr from each child process and writes:

- `<app-data>/logs/<process>-YYYY-MM-DD.log`

The desktop app provisions expected current-day runtime log files when the
app-data log directory is initialized and during periodic log maintenance.
Provisioning is create-if-missing only; it does not truncate existing user logs.
This lets Alloy attach to staged-but-not-yet-started wallet-bound bot log files
before the operator unlocks and starts the bot, including after UTC date rollover
during long-running app sessions.

Log files are JSON Lines. When backend/indexer/trading runtimes emit structured
JSON, the supervisor keeps the JSON payload at the start of the line and adds
bounded `process` and `stream` fields. It must not prepend text such as
`[stdout]` before JSON payloads because Alloy/Loki JSON parsing depends on the
first byte of each structured log line being `{`. Non-JSON child output is
wrapped in a small JSON envelope with `t`, `level`, `component`, `action`,
`process`, `stream`, and `msg`.

Desktop log files rotate by UTC day. App and supervisor log writes resolve the
current daily target on each append, so a long-running app naturally moves from
`<process>-2026-06-01.log` to `<process>-2026-06-02.log` at the UTC date
boundary. `DESKTOP_LOG_RETENTION_HOURS` controls retention for all app-data log
files and defaults to `48`, which keeps the current UTC day plus the previous UTC
day. A value of `24` keeps only the current UTC day; `72` keeps the current day
plus the previous two days. The desktop app runs periodic staging and cleanup
while it is open and also cleans up immediately after Admin config save/default
reset, so retention changes apply without requiring app relaunch.

It also emits log lines to frontend runtime event stream.
This includes wallet-bound bot process logs once those runtimes are started.

Admin runtime drawer process dropdown behavior:

- process list is sourced from:
  : explicit log file enumeration (`runtime_list_log_processes`) when hydrating runtime state
  : plus live `runtime-log` event process names as they appear
- this makes all existing process logs selectable even before supervisor transitions status to `running`

## Runtime Operations UI

Desktop UI is split into:

- admin UI (native Tauri WebView)
- userland UI (regular browser tab at backend localhost origin)

Admin UI mounts a dedicated shell in root layout (`frontend/src/routes/+layout.svelte`):

- shell tabs: `system`, `control`, `wallets`, `bots`, `logs`
- header action sequence: `config` -> `start infra` -> `enter the userland`
- Admin configuration controls: edit manifest-backed runtime settings grouped by topic, render `.env`, and toggle `autostart infra`
- live runtime state (`runtime-state-changed` event)
- live log stream (`runtime-log` event)
- controls: start / stop / restart / preflight
- paths: settings/env/logs paths, with settings/env existence status and open actions
- wallet metadata controls: import / export / remove
- bot controls: list / assign wallet / start / stop

Admin lifecycle UX is embedded in the `system` tab:

- available from the `system` tab while lifecycle phase is not `ready`
- shows lifecycle events as single-line rows with bracket tokens (`[level] [code]`) for copy-friendly logs
- remains in admin UI after startup as historical lifecycle stream

Tauri commands used by desktop frontend runtime UI/state:

- `app_config_get`
- `app_config_save`
- `app_config_use_defaults`
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
- `wallet_list`
- `wallet_get_status`
- `wallet_import`
- `wallet_export`
- `wallet_remove`
- `bot_list`
- `bot_assign_wallet`
- `bot_start`
- `bot_stop`

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
  : Check Admin `config`, app-data `settings.json`, the rendered `.env`, and required `DESKTOP_*` keys.

- Port already in use after abrupt stop
  : Current supervisor includes graceful stop + forced cleanup; if interrupted externally, verify no stale `nats-server`/runtime process remains before restart.

- Startup request reaches terminal API failure (`api.request.fail.final`)
  : Current boot flow does not include an automatic background recovery probe. If dependencies recover after terminal failure, trigger a manual reload/restart to resume normal route loading.
