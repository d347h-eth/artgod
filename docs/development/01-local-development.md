# Local Development

This document owns the long-form setup, configuration, and command reference
that used to live in the root README. Keep the README short; add detailed
local development workflow notes here.

## Quick Start

Local web/indexer development:

```sh
# Install Yarn Berry/PnP dependencies exactly from yarn.lock.
yarn install --immutable

# Start the local backend, indexer launcher, and frontend dev server.
yarn dev
```

Desktop dev from a clean checkout:

```sh
# Install Yarn Berry/PnP dependencies and materialize the PnP runtime files.
yarn install --immutable

# Build userland UI, runtime artifacts, desktop runtime resources, then start Tauri dev.
yarn dev:composition
```

`yarn dev:composition` is the clean-checkout desktop dev path. It runs:

```sh
yarn build:userland
yarn build:runtime
yarn build:desktop-runtime-resources
yarn dev:desktop
```

`cargo tauri dev` does not run `beforeBuildCommand`, so
`frontend/dist-userland` and `src-tauri/resources/runtime` must already exist
after a clean checkout or `yarn clean:build`. The debug sidecar is built by
`beforeDevCommand` before the admin frontend dev server starts.

Desktop no-bundle build from a clean checkout:

```sh
# Install Yarn Berry/PnP dependencies exactly from yarn.lock.
yarn install --immutable

# Run Tauri's beforeBuildCommand, which builds admin UI, userland UI, runtime artifacts, staged runtime resources, and release sidecars before compiling Rust.
yarn tauri build --debug --no-bundle --ci
```

## Bidding And Extension UI Tests

```sh
# Run deterministic browser tests for bidding automation flows with fixture-backed UI routes.
yarn test:bidding:automation

# Run deterministic public single-collection guardrails; verifies bid books stay visible while local bidding writes stay hidden.
yarn test:bidding:automation:public

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
Hypercastle suite mounts the production collection extension page shell with
fixture data, performs an in-browser SVG/interaction probe, and writes full-page
default/hover screenshots plus `terraforms-hypercastle-probe.json` under
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
  example root `0.0.1-pre-alpha.3` -> tag `v0.0.1-pre-alpha.3`.
- Run `yarn sync:version` before building release artifacts or pushing a
  release tag so Tauri, Cargo, workspace manifests, and OpenAPI stay aligned.

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
- the token preview modal endpoint, default media mode only, with
  stale-while-revalidate warmup from the default collection page

Leave it `disabled` for local/admin setups unless you explicitly want that
behavior.

## Desktop Runtime Configuration

Desktop runtime configuration is managed from the native Admin UI `config`
section. The Rust app embeds `config/settings.manifest.toml` as the Admin config
schema/default source, stores only operator overrides in a versioned app-data
JSON file, and renders the runtime `.env` from effective manifest defaults plus
overrides only after the operator chooses defaults, saves configuration, or
launches from saved configuration.

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
- Trigger: push tag `v*`, for example `v0.1.0`.
- Targets: Linux x64, Windows x64, macOS universal.
- Outputs: signed release bundles, `SHA256SUMS.txt`, `SHA256SUMS.txt.asc`,
  Linux detached signatures, and GitHub build provenance attestation.

Keep the release tag aligned with the root `package.json` version as described
in `Versioning` above.

For all desktop release details, signing/notarization setup, required secrets,
verification commands, and CI flow, see:

- `docs/desktop/01-tauri-build-and-runtime.md`

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

# Remove generated build artifacts and caches.
yarn clean:build
```
