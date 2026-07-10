# Tauri Build and Runtime Pipeline

This document describes the current desktop pipeline end-to-end:

1. how artifacts are built
2. how Tauri assembles the app
3. how the desktop runtime supervisor launches backend/indexer/NATS
4. how shutdown, restart, and cleanup behave
5. how release bundles are produced in CI

It is the canonical technical reference for desktop composition in this repository.

Project versioning is documented in `docs/development/01-local-development.md`.
For desktop releases, keep the release tag aligned with the root `package.json` version (`v<root-version>`) and run `yarn sync:version` before building or publishing release artifacts.

For add/remove runtime registry maintenance, see:

- `docs/desktop/02-runtime-registry-maintenance.md`

For desktop wallet custody, native secret prompts, and bot unlock policy, see:

- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`

For deferred local runtime identity and browser trust-store work, see:

- `docs/progress/desktop/02-local-runtime-identity-and-browser-trust.md`

For release signing procurement and CI secret setup, see:

- `docs/desktop/06-release-signing-runbook.md`

For detailed Linux GPG release-key setup, rotation, and GitHub Actions secret
handling, see:

- `docs/desktop/05-linux-gpg-release-signing.md`

## Scope and Goals

The desktop build/runtime pipeline is designed to:

- keep frontend/backend/indexer/trading in one local executable wrapper
- keep core-composition runtime behavior explicit and fail-fast
- avoid relying on development launch commands in production desktop mode
- make release builds reproducible in public CI

The desktop shell does not replace backend/indexer/trading logic. It orchestrates existing runtimes.

## Executable Lifecycle Summary

1. Rust app process initializes and exposes runtime commands. Startup is
   deferred; there is no immediate supervisor auto-start in `setup`.
2. System tray is initialized with native actions: `open ArtGod in browser`,
   `open admin UI`, and `shutdown`.
3. Admin UI runs in the native Tauri window and exposes the privileged desktop
   control plane: `config`, `system`, `wallets`, `bots`, and header
   logs/open/stop/shutdown actions.
4. Userland UI runs in a regular browser tab and is served by the local backend
   origin.
5. Frontend boot lifecycle orchestrator initializes, waits for Tauri bridge
   readiness, then invokes `runtime_auto_start`; unconfigured installs and
   installs with `autostart infra` disabled stay stopped behind the Admin header
   action sequence.
6. When startup is requested, the supervisor starts local NATS from bundled
   `nats-server`, then backend, then enabled indexer workers from bundled
   resources using bundled Node and Yarn PnP hooks. OpenSea workers are skipped
   when OpenSea integration is disabled, and wallet-bound trading bots are
   staged but start only on explicit operator action after unlock.
7. Boot lifecycle console stays visible until lifecycle backend readiness probe
   succeeds, not merely until process state is `running`.
8. Any core composition process exit triggers fail-fast full stack restart.
   Wallet-bound trading bots are supervised separately and stop only when they
   crash or when one of their declared critical dependencies becomes unhealthy.
9. Closing the admin window hides it. The runtime keeps running in the tray.
   Graceful runtime shutdown is triggered explicitly via tray `shutdown` or app
   exit.

## Build Commands

Root build/helper commands:

```sh
yarn install --immutable
yarn build:sqlite-native
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

`yarn tauri ...` resolves the project-pinned `@tauri-apps/cli` binary. The
desktop workflows do not require the separate Cargo `tauri` subcommand.

What each command does:

- `yarn build:sqlite-native`
  : Runs `scripts/build/build-sqlite-native-binding.mjs`.
  : Invokes only the trusted `better-sqlite3` package-local install step from `.yarn/unplugged` and fails if `build/Release/better_sqlite3.node` is missing.

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
- `beforeBundleCommand = "node ./scripts/build/macos-code-signing.mjs sign-staged"`
- `frontendDist = "../frontend/dist"`

This ensures `yarn tauri build ...` always has:

1. desktop frontend static output
2. browser userland static output
3. backend/indexer runtime `.mjs` artifacts
4. staged runtime resources under `src-tauri/resources/runtime`
5. staged native sidecar binaries under `src-tauri/binaries`
6. macOS signatures on staged Mach-O runtime resources and sidecars before DMG assembly

before final Tauri bundle generation starts.

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
- native packages declared by `scripts/build/native-runtime-dependencies.mjs` are externalized (`better-sqlite3`, `sharp`)
- Node `require` shim banner is injected for CJS dependencies bundled into ESM output
- explicit `tsconfigRaw` is provided so runtime build does not depend on frontend `.svelte-kit` TS config state

Native package note:

- `better-sqlite3` and `sharp` stay as runtime PnP imports because their package-local loaders need access to native files under `.yarn/unplugged`.
- `.yarnrc.yml` keeps `enableScripts: false`; CI must not override it with `YARN_ENABLE_SCRIPTS=true`.
- `better-sqlite3` is built through the explicit trusted step `yarn build:sqlite-native`, which runs only its package-local install script from the unplugged package directory and fails if `build/Release/better_sqlite3.node` is missing.
- `sharp` uses its optional `@img/*` prebuilt packages; it is not enabled through a broad post-install script policy.
- `scripts/build/check-native-runtime-dependencies.mjs` can be run after `yarn build:runtime` to verify native runtime packages load from the same package boundaries used by bundled artifacts.

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
- prunes native prebuild directories that do not match the bundled Node target
- prunes Yarn cache archives for packages that PnP resolves from
  `.yarn/unplugged`, because those archives are duplicate runtime inputs and
  can contain unsigned native binaries that platform bundle tooling scans inside
  Linux AppImage or macOS DMG artifacts
- prunes musl `.node` files from Linux glibc runtime targets because
  linuxdeploy scans all ELF files staged into the AppImage tree, including
  unused native prebuilds under `.yarn/unplugged`

### `scripts/build/prepare-desktop-sidecars.mjs`

Responsibilities:

- builds the native secret-prompt sidecar crate for the active target triple
- stages the built binary into `src-tauri/binaries/artgod-secret-prompt-<target-triple>(.exe)`
- stages a fat `artgod-secret-prompt-universal-apple-darwin` sidecar when Tauri builds the macOS universal target
- keeps sidecar build output separate from the main `src-tauri/target` tree by using `src-tauri/target/sidecars`

### `scripts/build/macos-code-signing.mjs`

Responsibilities:

- signs staged macOS executable/loadable Mach-O files under `src-tauri/resources/runtime` and `src-tauri/binaries` before Tauri generates the final bundle artifacts
- covers the bundled Node runtime, bundled NATS runtime, native `.node` add-ons from `.yarn/unplugged`, and the native secret-prompt sidecar
- skips non-macOS targets and local macOS builds without `APPLE_SIGNING_IDENTITY`
- mounts the produced DMG and verifies that the contained `.app` has signed Node, NATS, and secret-prompt executables before notarization

### `scripts/build/macos-notarization.mjs`

Responsibilities:

- verifies and hashes the signed DMG before submission
- submits once without coupling upload to Apple's processing wait
- persists the submission ID and retries transient status-query failures
- redacts credentials from live child-process output, errors, and saved diagnostics before emission
- verifies Apple's accepted log against the preserved DMG SHA-256
- staples immediately or resumes the same submission and DMG from a later
  manual workflow run

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
- `src-tauri/binaries/artgod-secret-prompt-universal-apple-darwin` for macOS universal release builds

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

Userland link settings:

- `BLOCK_EXPLORER_BASE_URL` controls the explorer origin used by lookup links.
- `BLOCK_EXPLORER_TX_PATH_TEMPLATE`, `BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE`, and `BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE` control transaction, address, and block lookup paths.

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
- `BIDDING_BID_BOOK_*` and `BIDDING_RUNTIME_HEARTBEAT_*` (bot snapshot projection, backend source freshness, UI bid-book live-refresh cadence, and bot heartbeat liveness)
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

## Runtime Operations UI

Desktop UI is split into:

- admin UI (native Tauri WebView)
- userland UI (regular browser tab at backend localhost origin)

Admin UI mounts a dedicated shell in root layout (`frontend/src/routes/+layout.svelte`):

- shell tabs: `system`, `wallets`, `bots`
- header action sequence: `config` -> `start infra` -> `enter the userland`
- secondary header actions: `logs`, `stop infra`, `shutdown`
- Admin configuration controls: edit manifest-backed runtime settings grouped by topic, render `.env`, and toggle `autostart infra`
- live runtime state (`runtime-state-changed` event)
- logs folder opener: opens the app-data logs directory in the native file browser
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
- `runtime_shutdown`
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

- `.github/workflows/tauri-build-check.yml` (no-bundle Linux check)
- `.github/workflows/tauri-release.yml`
- `.github/workflows/tauri-repro-check.yml` (unsigned Linux reproducibility parity check)

Trigger:

- build check: pull request, push to `main`, or manual dispatch
- release: push tag `v*`
- reproducibility check: push tag `v*` or manual dispatch

Release metadata:

- Shipped alpha/beta/rc tags, such as `v0.0.1-alpha.1`, publish as normal
  GitHub releases and are marked Latest.
- Test tags containing `-test.`, such as `v0.0.1-test.1`, publish as GitHub
  pre-releases and are not marked Latest.
- Plain stable tags such as `v1.0.0` also publish as normal Latest releases.

Build-check trigger policy:

- Do not add `paths-ignore` for version-sync files; they are build-critical
  inputs for Tauri, Cargo, and workspace packaging.
- For a version-only `yarn sync:version` commit after a green merge commit on
  `main`, use GitHub's `skip-checks: true` commit trailer only when no other
  files changed.

Build matrix:

- Linux x64 (`x86_64-unknown-linux-gnu`)
- macOS universal (`universal-apple-darwin`)

Outputs:

- bundle artifacts uploaded to GitHub Release
- `SHA256SUMS.txt`
- `SHA256SUMS.txt.asc`
- Linux detached signatures (`*.AppImage.asc`, `*.deb.asc`)
- build provenance attestation

Current state:

- Yarn package lifecycle scripts stay disabled in CI. Workflows run
  `yarn install --immutable`, then `yarn build:sqlite-native` for the
  allowlisted `better-sqlite3` native binding.
- Linux artifacts are GPG-signed (detached armor signatures).
- macOS DMG is code-signed, notarized, and stapled in CI. The release workflow
  preserves the exact submitted DMG and Apple submission state before bounded
  polling, so delayed submissions can be resumed from the original release tag
  without rebuilding or resubmitting.
- Windows release builds are deferred for the first public alpha. When Windows
  releases are enabled later, signing should use SSL.com eSigner CKA with
  `signtool.exe` on the Windows runner.

Release secrets expected by CI:

Store release signing and notarization secrets as GitHub Environment secrets in
`desktop-release-signing`, not as repository-wide secrets. The release workflow
declares that environment on the jobs that need secrets. The build-check and
reproducibility workflows do not use signing secrets.

- Linux GPG:
    - `LINUX_GPG_PRIVATE_KEY_ASC`
    - `LINUX_GPG_PASSPHRASE`
    - `LINUX_GPG_KEY_ID`
    - optional: `LINUX_GPG_OWNERTRUST`
      Detailed key-generation, subkey, rotation, and compromise-response guidance
      is in `docs/desktop/05-linux-gpg-release-signing.md`.
- macOS:
    - `APPLE_CERTIFICATE` (base64 `.p12`)
    - `APPLE_CERTIFICATE_PASSWORD`
    - `APPLE_SIGNING_IDENTITY`
    - `APPLE_API_KEY_P8_B64` (base64 `.p8`)
    - `APPLE_API_KEY_ID`
    - `APPLE_API_ISSUER`

Windows maintainer-profile note:

- The release-signing runbook treats SSL.com Personal Identity Code Signing
  with eSigner for Code as the future Windows path.
- The alpha release workflow does not build Windows artifacts.

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
  : Run `yarn install --immutable && yarn build:sqlite-native && yarn build:runtime && yarn build:desktop-runtime-resources`.

- Stale dist/cache state
  : Run `yarn clean:build`.

- Desktop config key errors on startup
  : Check Admin `config`, app-data `settings.json`, the rendered `.env`, and required `DESKTOP_*` keys.

- Port already in use after abrupt stop
  : Current supervisor includes graceful stop + forced cleanup; if interrupted externally, verify no stale `nats-server`/runtime process remains before restart.

- Startup request reaches terminal API failure (`api.request.fail.final`)
  : Current boot flow does not include an automatic background recovery probe. If dependencies recover after terminal failure, trigger a manual reload/restart to resume normal route loading.
