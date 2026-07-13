# Local Development

This document owns the long-form setup, configuration, and command reference
that used to live in the root README. Keep the README short; add detailed
local development workflow notes here.

## Quick Start

Local web/indexer development:

```sh
# Install Yarn Berry/PnP dependencies exactly from yarn.lock.
yarn install --immutable

# Build the trusted native SQLite dependency; package scripts stay disabled globally.
yarn build:sqlite-native

# Start the local backend, indexer launcher, and frontend dev server.
yarn dev
```

Desktop dev from a clean checkout:

```sh
# Install Yarn Berry/PnP dependencies and materialize the PnP runtime files.
yarn install --immutable

# Build the trusted native SQLite dependency; package scripts stay disabled globally.
yarn build:sqlite-native

# Build userland UI, runtime artifacts, desktop runtime resources, then start Tauri dev.
yarn dev:composition
```

`yarn dev:composition` is the clean-checkout desktop dev path. It runs:

```sh
yarn build:userland
yarn build:desktop-runtime
yarn build:desktop-runtime-resources
yarn dev:desktop
```

`yarn dev:desktop` runs `tauri dev --no-watch`, which does not run
`beforeBuildCommand`, so
`frontend/dist-userland` and `src-tauri/resources/runtime` must already exist
after a clean checkout or `yarn clean:build`. The debug sidecar is built by
`beforeDevCommand` before the admin frontend dev server starts.

Desktop no-bundle build from a clean checkout:

```sh
# Install Yarn Berry/PnP dependencies exactly from yarn.lock.
yarn install --immutable

# Build the trusted native SQLite dependency; package scripts stay disabled globally.
yarn build:sqlite-native

# Build a release-mode executable and adjacent runtime resources without packaging a bundle.
yarn build:desktop:no-bundle
```

`yarn build:desktop:no-bundle` is the canonical local release-like QA path. It
exercises wallet-recipient integrity validation and supports repeated builds
without `yarn clean:build`: the Rust build step removes only Tauri's prior
copied `resources/runtime` tree and writes the freshly staged tree beside the
Linux executable after Tauri's build step.
Cargo dependencies, incremental outputs, executables, and bundle artifacts are
preserved. Pass `--debug` for a faster debug no-bundle build; debug builds do
not enforce release runtime hashes. After a debug build, run
`yarn check:desktop-no-bundle-runtime` to compare its actual adjacent runtime
with staging exactly; this is the same one-build output check used by CI.

## Build From Source

Use this path when you want a real desktop bundle built on your own machine
instead of downloading GitHub Release artifacts.

Prerequisites:

- Node `24.3.0` with Corepack enabled.
- Yarn `4.12.0` from the checked-in `packageManager` field.
- Rust toolchain matching `rust-toolchain.toml`.
- Linux: Tauri WebKit/GTK dependencies plus `libfuse2`, `libssl-dev`,
  `libxdo-dev`, `patchelf`, `file`, `xdg-utils`, `python3`, `make`, and `g++`.
- macOS: Xcode Command Line Tools.
- Windows: Microsoft C++ Build Tools / Visual Studio Build Tools with the MSVC
  toolchain and Windows SDK.

Build on the target operating system. Official CI release packaging currently
targets Linux and macOS only, but source builds are supported for Linux, macOS,
and Windows.

Fresh checkout build sequence:

```sh
corepack enable
yarn install --immutable
yarn build:sqlite-native
```

Linux x64 bundle:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libfuse2 libssl-dev libxdo-dev patchelf file xdg-utils python3 make g++
yarn prepare:tauri-linux-tools
yarn tauri build --ci --target x86_64-unknown-linux-gnu --bundles appimage,deb
yarn check:linux-bundled-runtime src-tauri/target/x86_64-unknown-linux-gnu/release/bundle
```

The preparation step materializes the exact AppImage packaging tools pinned in
`config/tauri-linux-bundler-tools.json`. It verifies their sizes and SHA-256
values before Tauri can execute them; a moved upstream asset fails the build.

Ubuntu 22 release-lane reproduction in Docker:

```sh
scripts/build/reproduce-linux-release-docker.sh
```

The helper mirrors the GitHub Linux release lane: Ubuntu `22.04`, Node from
`package.json`, Rust from `rust-toolchain.toml`, the Linux packaging
dependencies from `.github/workflows/tauri-release.yml`, and the same Tauri
AppImage/`.deb` build command. It restores ownership of generated build
artifacts after the container exits.

macOS universal DMG:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
yarn tauri build --ci --target universal-apple-darwin --bundles dmg
```

The Tauri application shell, Node, and NATS are universal, while the staged
SQLite and Sharp native add-ons match the build host architecture. The local
backend, indexer, and trading runtime is therefore not supported or verified
on the opposite architecture; see
`docs/desktop/01-tauri-build-and-runtime.md`.

Windows x64 NSIS installer:

```powershell
rustup target add x86_64-pc-windows-msvc
yarn tauri build --ci --target x86_64-pc-windows-msvc --bundles nsis
```

`yarn build:sqlite-native` is required after a fresh install because
`.yarnrc.yml` keeps `enableScripts: false`. The command runs only the trusted
`better-sqlite3` package-local install step from `.yarn/unplugged` and fails if
the native SQLite binding is missing.

Locally built bundles are not equivalent to official release artifacts unless
you also provide the same signing/notarization setup. Windows source-built
installers are expected to be unsigned unless the builder provides their own
code-signing setup. The official release pipeline remains documented in
`docs/desktop/06-release-signing-runbook.md`.

## Bidding And Extension UI Tests

```sh
# Run deterministic browser tests for bidding automation flows with fixture-backed UI routes.
yarn test:bidding:automation

# Run deterministic public single-collection guardrails; verifies bid books stay visible while local bidding writes stay hidden.
yarn test:bidding:automation:public

# Run deterministic Terraforms media source, preference, version, retry, and responsive-layout checks.
yarn test:terraforms:media

# Run deterministic Terraforms Hypercastle page checks with browser probing and screenshot artifacts.
yarn test:terraforms:hypercastle

# Start the local app before running attached smoke tests against live local data.
yarn dev

# In another terminal, run the small attached smoke suite for bidding panel geometry and representative live wiring.
yarn test:bidding:attached
```

The deterministic suites use `/e2e-harness/collection` routes, do not require
OpenSea, the bidding bot runtime, or a local SQLite dataset, and are the primary
coverage for bidding automation and extension-page UI behavior. The Terraforms
media suite exercises the production toolbar, preview modal, and token-detail
surface at desktop and touch viewports, including live request retries and
no-cache behavior. The Terraforms Hypercastle suite mounts the production
collection extension page shell with fixture data, performs an in-browser
SVG/interaction probe, and writes full-page default/hover screenshots plus
`terraforms-hypercastle-probe.json` under
`frontend/test-results/playwright-terraforms-hypercastle/` for visual iteration.
The attached smoke suite intentionally stays small because it depends on
whatever local app/data is currently running.

## Ad-Hoc Web-Hosted Deploy

```sh
cp .env.deploy.example .env.deploy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up --build -d
```

Hosted deployment is currently documented as a public read-only instance that
can sit behind an existing VPS reverse proxy, with an optional bundled Caddy
profile in the deploy compose. For the exact env contract, routing shape, and
manual admin model, see:

- `docs/deploy/01-web-hosted-read-only.md`

## Versioning

The canonical project version lives in the root `package.json` `version` field.

When you bump the version, update it there first, then run:

```sh
yarn sync:version
yarn check:version
```

That propagates the root version into the places that require materialized
version fields:

- workspace `package.json` files
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `docs/backend-api.openapi.yaml`

Notes:

- The frontend build reads the app version directly from the root workspace
  version. There is no separate app-version deploy env override.
- Desktop release tags should match the root version with a leading `v`, for
  example root `0.0.1-pre-alpha.3` -> shipped tag
  `v0.0.1-pre-alpha.3`. Dry-run tags append `-test.N`, where `N` is a positive
  integer, to that exact tag.
- Run `yarn sync:version` before building release artifacts or pushing a
  release tag so Tauri, Cargo, workspace manifests, and OpenAPI stay aligned.
- `yarn check:version` performs the same contract check without modifying any
  file. The release workflow runs this through its signed-tag admission gate.

## Node Dependency Security Verification

Yarn dependency updates keep install scripts disabled and use the checked-in
30-day npm age gate. For dependency-update review and release verification, run
the hardened lockfile metadata check and high-or-critical advisory audit:

```sh
yarn security:yarn:verify-lockfile
yarn security:yarn:audit
yarn security:yarn:verify
```

- `yarn security:yarn:verify-lockfile` runs `yarn install` with immutable,
  refresh-lockfile, check-resolutions, and skip-build flags. It keeps the final
  lockfile fixed while forcing Yarn to validate package metadata and resolution
  coherence against the registry.
- `yarn security:yarn:audit` runs the npm advisory audit across all workspaces
  and transitive dependencies at `high` severity and above.
- `yarn security:yarn:verify` runs both checks in sequence and is the default
  local command before committing broad Node/Yarn lockfile updates.
- `.github/workflows/dependency-security-check.yml` runs these checks for
  dependency-touching pull requests and `main` pushes. The release workflow also
  gates tag builds on the same checks.
- CI runs `yarn install --immutable --mode=skip-build` before these aliases,
  because GitHub's fresh checkout cannot run package scripts until Yarn has
  created the project install state.

## Cargo Dependency Age Gate

Rust dependency updates use a best-effort age gate to mirror Yarn's minimum-age
policy without running a custom crates.io mirror.

```sh
yarn cargo:update-aged --dry-run
yarn cargo:update-aged
yarn cargo:age-gate
```

- `yarn cargo:update-aged` reads `src-tauri/Cargo.lock`, queries crates.io, and
  steers each locked crates.io package toward the newest non-yanked,
  Cargo-caret-compatible version that is at least the configured age.
- `yarn cargo:age-gate` is read-only and fails when the final lockfile contains
  package versions newer than the configured age without a policy exception.
- `config/cargo-age-gate.json` owns the minimum age and explicit fresh-version
  exceptions for urgent security or release-readiness cases.
- Use `--package <name>` or `--package <name@version>` to scope either command
  to one package while investigating an alert.
- CI runs `yarn install --immutable --mode=skip-build` before this alias for
  the same fresh-checkout package-script install-state reason.

## Local Infrastructure

Start local infra with NATS and JetStream:

```sh
docker compose up -d
```

Start the optional observability stack with Grafana, Loki, Alloy, Prometheus,
Tempo, and Pyroscope:

```sh
yarn observability:up
```

Use `yarn observability:stop` to stop those containers and
`yarn observability:down` to remove only those observability service containers.

Open Grafana at `http://localhost:42735` with the default `admin` / `admin`
credentials.

Use the local launchers to produce runtime log files under `tmp/logs/*.log`:

```sh
./scripts/backend-dev.sh
./scripts/indexer-dev.sh
```

Run indexer runtimes as needed:

```sh
yarn workspace @artgod/indexer run dev:scheduler-worker
yarn workspace @artgod/indexer run dev:sync-worker
yarn workspace @artgod/indexer run dev:reorg-worker
yarn workspace @artgod/indexer run dev:domain-worker
yarn workspace @artgod/indexer run dev:bootstrap-worker
yarn workspace @artgod/indexer run dev:collection-extension-worker
yarn workspace @artgod/indexer run dev:offchain-ingest-worker
yarn workspace @artgod/indexer run dev:opensea-stream-worker
yarn workspace @artgod/indexer run dev:opensea-bootstrap-worker
yarn workspace @artgod/indexer run dev:opensea-reconcile-worker
yarn workspace @artgod/indexer run dev:opensea-reconcile-scheduler-worker
yarn workspace @artgod/indexer run dev:dead-letter-worker
```

## Configuration

Create env files:

```sh
yarn config:check
cp .env.example .env
cp .env.test.example .env.test
```

`.env.example`, `.env.deploy.example`, and
`shared/config/generated-settings-defaults.ts` are generated from
`config/settings.manifest.toml`. Edit the manifest first, then run
`yarn config:generate` and commit the manifest plus generated files together.
See `docs/desktop/04-settings-manifest-process.md` for the full process.

The generated `.env.example` is the local web/indexer development baseline.
Keep deploy-only and desktop-only values such as `INTERNAL_BACKEND_ORIGIN` and
`USERLAND_UI_DIST_DIR` blank there unless local dev is intentionally serving a
built static userland bundle. Hosted Docker deploy values belong in generated
`.env.deploy.example`; desktop runtime values come from manifest desktop
defaults and Admin-rendered app-data env.

Required core env:

```sh
ARTGOD_DB_PATH=database/sqlite/main/db
BACKEND_HOST=127.0.0.1
RPC_URL_LIST=[{"url":"http://127.0.0.1:42721","weight":1}]
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63
```

Useful optional env groups:

- Backend HTTP/security: `BACKEND_HOST`, `BACKEND_ALLOWED_HOSTS`,
  `BACKEND_ALLOWED_ORIGINS`, `BACKEND_CSRF_COOKIE_SECURE`,
  `PUBLIC_BACKEND_ORIGIN`.
- Block explorer links: `BLOCK_EXPLORER_BASE_URL`,
  `BLOCK_EXPLORER_*_PATH_TEMPLATE`.
- Backend query cache: `BACKEND_QUERY_CACHE_PROVIDER`,
  `BACKEND_PUBLIC_COLLECTION_*`, `BACKEND_QUERY_CACHE_TOKEN_PREVIEW_*`.
- Observability signal-store endpoints: `OBSERVABILITY_OTLP_HTTP_URL`,
  `OBSERVABILITY_PYROSCOPE_URL`.
- Backend observability: `BACKEND_METRICS_*`, `BACKEND_APM_*`.
- RPC endpoint pools and resilience: `RPC_URL_LIST`,
  `RPC_BACKFILL_URL_LIST`, `RPC_HTTP_REQUEST_TIMEOUT_MS`, `RPC_RETRY_*`,
  `RPC_RATE_LIMIT_*`, `RPC_CIRCUIT_BREAKER_*`.
- Metadata and bootstrap media tuning: `METADATA_REFRESH_RANGE_CHUNK_SIZE`,
  `BOOTSTRAP_METADATA_*`, `BOOTSTRAP_IMAGE_CACHE_*`.
- IPFS/media cache and HTTP fetch resilience: `COMMON_IPFS_GATEWAY_ORIGIN`,
  `COMMON_MEDIA_CACHE_DIR`, `COMMON_HTTP_FETCH_*`.
- Offchain storage: `OFFCHAIN_PERSIST_RAW_OBSERVATIONS`.
- Debug payload storage: `PERSIST_RAW_DEBUG_PAYLOADS`.
- OpenSea integration: `OPENSEA_INTEGRATION_MODE`, `OPENSEA_API_KEY`.
- Trading bot OpenSea lanes: `OPENSEA_STREAM_SECRET_KEY`,
  `OPENSEA_BIDDING_SECRET_KEY`, `OPENSEA_SNAPSHOT_SECRET_KEY`.
- Trading bot command reconciliation and bid-book freshness/live refresh:
  `BIDDING_COMMAND_*`, `BIDDING_BID_BOOK_*`,
  `BIDDING_RUNTIME_HEARTBEAT_*`.
- Trading bot transaction policy: `BIDDING_TX_MIN_PRIORITY_FEE_GWEI`,
  `BIDDING_TX_FEE_HISTORY_*`, `BIDDING_TX_BASE_FEE_MULTIPLIER`,
  `BIDDING_TX_MAX_FEE_GWEI`, `BIDDING_TX_PENDING_NONCE_POLICY`.
- Indexer metrics: `INDEXER_METRICS_ENABLED`, `INDEXER_METRICS_HOST`,
  `INDEXER_METRICS_PORT_*`.
- Indexer APM: `INDEXER_APM_ENABLED`, `INDEXER_APM_*`.

See `config/settings.manifest.toml`, the generated `.env.example`, generated
`.env.deploy.example`, `shared/config/generated-settings-defaults.ts`,
`docs/desktop/04-settings-manifest-process.md`, and
`docs/indexer/01-config-and-env.md` for full definitions.

`BACKEND_QUERY_CACHE_PROVIDER=memory` enables a lightweight in-memory cache for
expensive backend read queries. The current cached paths are:

- the default collection browser request for the public collection page
  (`listed`, first page, no filters)
- eligible snapshot requests for the token preview modal, keyed by source,
  preference, and token-local variant, with stale-while-revalidate warmup from
  the default collection page

Request-time live media is never eligible for backend preview caching or
frontend adjacent-token prefetch.

Leave it `disabled` for local/admin setups unless you explicitly want that
behavior.

## Desktop Runtime Configuration

Desktop runtime configuration is managed from the native Admin UI `config`
section. The Rust app embeds `config/settings.manifest.toml` as the Admin config
schema/default source, stores only operator overrides in a versioned app-data
JSON file, and renders the runtime `.env` from effective manifest defaults plus
overrides only after the operator chooses defaults, saves configuration, or
launches from saved configuration.

Executable resources are not configurable through Admin. Desktop Node, NATS,
runtime artifacts, and their isolated package-local dependencies always come
from the staged Tauri `runtime` resources built by
`yarn build:desktop-runtime-resources`.

A stale `.env` without `settings.json` is treated as an inactive legacy file:
Admin can show that it exists, but the supervisor will not boot from it.

On first launch, Admin can populate an empty `RPC_URL_LIST` automatically by
benchmarking the embedded Chainlist Ethereum HTTP RPC payload. The config form
also exposes manual Chainlist benchmark actions and a tracking-policy selector
before the generated endpoint list is saved.

Rendered desktop runtime env file:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\.env`

Versioned Admin settings file:

- Linux: `~/.local/share/network.artgod.desktop/config/settings.json`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/settings.json`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\settings.json`

Desktop-first path defaults:

- `ARTGOD_DB_PATH=sqlite/main/db`, resolved relative to app-data dir unless
  absolute.
- `USERLAND_UI_DIST_DIR=frontend/userland`, resolved relative to desktop
  runtime resources dir unless absolute.
- `OPENSEA_INTEGRATION_MODE=auto`, so OpenSea workers start only when
  `OPENSEA_API_KEY` is configured.

## Desktop Release Builds

Desktop release artifacts are built publicly in GitHub Actions.

- Main release workflow: `.github/workflows/tauri-release.yml`
- Reproducibility workflow: `.github/workflows/tauri-repro-check.yml`, unsigned
  Linux parity.
- Trigger: push a GitHub-verified OpenPGP annotated tag that exactly matches
  `v<root-package-version>` or appends the dry-run suffix `-test.N`, where `N`
  is a positive integer.
- Targets: Linux x64 and macOS universal. Windows release packaging remains
  deferred for the public alpha; Windows source builds are still supported.
- Outputs: signed release bundles, `SHA256SUMS.txt`, `SHA256SUMS.txt.asc`, the
  public release key, Linux detached signatures, and GitHub build provenance
  attestation.

Keep the release tag aligned with the root `package.json` version as described
in `Versioning` above.

For all desktop release details, signing/notarization setup, required secrets,
verification commands, and CI flow, see:

- `docs/desktop/01-tauri-build-and-runtime.md`
- `docs/desktop/05-linux-gpg-release-signing.md`
- `docs/desktop/06-release-signing-runbook.md`

For the current hosted Docker deployment shape, public reads, local-only writes,
external shared proxy, and optional bundled Caddy, see:

- `docs/deploy/01-web-hosted-read-only.md`

## VSCode

Yarn PnP SDK setup:

```sh
yarn dlx @yarnpkg/sdks vscode
```

## Common Commands

```sh
# Start backend, indexer launcher, and frontend dev server.
yarn dev

# Build staged desktop resources and start the desktop dev shell.
yarn dev:composition

# Build the release-like no-bundle desktop executable for local QA.
yarn build:desktop:no-bundle

# Start only the backend workspace dev server.
yarn workspace @artgod/backend run dev

# Start only the backend workspace dev server with a local observability log file.
./scripts/backend-dev.sh

# Start only the frontend workspace dev server.
yarn workspace @artgod/frontend run dev

# Start only the indexer workspace dev entrypoint.
yarn workspace @artgod/indexer run dev

# Inspect a JetStream queue backlog without consuming or acknowledging messages.
yarn workspace @artgod/indexer run inspect:queue -- --queue order-updates-by-maker --limit 10000

# Validate runtime registry consistency across build maps, supervisor mappings, dev launchers, and observability mappings.
yarn check:runtime-registry

# Remove all generated build artifacts and caches for broad recovery.
yarn clean:build
```
