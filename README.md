# ArtGod

Local-first desktop app for NFT indexing and trading workflows.
All core services run on the user's machine (no centralized ArtGod servers).

## Canonical Status

This `README.md` is the canonical human-facing project status document.

Current implementation snapshot:

- Multi-runtime indexer is active and queue-driven (NATS JetStream + SQLite).
- Realtime sync, backfill sync, and reorg checks are implemented.
- Collection bootstrap is implemented (metadata-first, optional local token-image cache, then ownership snapshot + short backfill).
- Fresh installs seed Terraforms as the first prepared collection row, visible for manual `start bootstrapping` or immediate purge without writing token/bootstrap data.
- Domain projections for orders, metadata, and activities are implemented.
- Offchain ingestion includes OpenSea live stream ingestion, bootstrap snapshots, periodic reconciliation, and normalization into canonical order state.
- Collection extensions are build-bundled and DB-activated; Terraforms is the first embedded extension for metadata-side artifacts, sync enrichment, and backend media overrides.
    - Terraforms collection browsing exposes `artifact`, `snapshot`, and extension-provided `live`; token detail and preview can also expose a token-local `lost` mode when the extra V2 lost-terrain artifact exists
- Userland collection browsing includes shared collection-page chrome, tokens / activities / holders sections, reusable trait facets, collection activity feeds, and owner-scoped token browsing.
- Blockspace exploration is implemented with stacked isometric levels, stable bucket ranges, live coverage refresh, manual backfill selection, and public single-collection cache diagnostics.
- Local observability stack is available (logs, metrics, traces, profiles).
- Tauri desktop runtime supervisor composes local NATS + backend + indexer workers from production runtime artifacts.
- Desktop admin UI now includes header launch/logs/stop/shutdown actions plus system, wallets, and bots surfaces behind the native Tauri shell.
- Desktop wallet custody is implemented with Rust-owned Ethereum keystore storage, native secret prompts, and one-shot stdin secret handoff into wallet-bound trading runtimes.
- Bidding runtime is operational with DB-backed job management, secure wallet unlock, direct OpenSea bidding/snapshot lanes, WETH allowance bootstrap, and live command reconciliation.
- Bid-book UI is implemented for collection bidding and token detail pages, sourcing from the live/fresh bot snapshot projection when bidding is active and from canonical orders otherwise.
- Bidding automation UI is implemented for token, trait, and collection targets, with reusable token-card selection, contextual bid drafts, collection price tiers, staged tier reapply, and shared bidding panels.

Canonical backlog and priorities live in `docs/progress/indexer/15-unified-backlog.md`.

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

# Build the browser/userland static UI into frontend/dist-userland.
yarn build:userland

# Bundle backend, indexer workers, and trading bot runtimes into */dist-desktop.
yarn build:runtime

# Stage runtime artifacts, userland UI, DB migrations, Yarn PnP data, bundled Node, and bundled NATS into src-tauri/resources/runtime.
yarn build:desktop-runtime-resources

# Start the Tauri dev shell; beforeDevCommand builds the debug sidecar first, then starts the admin frontend dev server.
yarn dev:desktop
```

`cargo tauri dev` does not run `beforeBuildCommand`, so `frontend/dist-userland` and `src-tauri/resources/runtime` must already exist after a clean checkout or `yarn clean:build`. The debug sidecar is built by `beforeDevCommand` before the admin frontend dev server starts.

Desktop no-bundle build from a clean checkout:

```sh
# Install Yarn Berry/PnP dependencies exactly from yarn.lock.
yarn install --immutable

# Run Tauri's beforeBuildCommand, which builds admin UI, userland UI, runtime artifacts, staged runtime resources, and release sidecars before compiling Rust.
yarn tauri build --debug --no-bundle --ci
```

Bidding automation E2E tests:

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

The deterministic suites use `/e2e-harness/collection` routes, do not require OpenSea, the bidding bot runtime, or a local SQLite dataset, and are the primary coverage for bidding automation and extension-page UI behavior. The Terraforms Hypercastle suite mounts the production collection extension page shell with fixture data, performs an in-browser SVG/interaction probe, and writes full-page default/hover screenshots plus `terraforms-hypercastle-probe.json` under `frontend/test-results/playwright-terraforms-hypercastle/` for visual iteration. The attached smoke suite intentionally stays small because it depends on whatever local app/data is currently running.

Ad-hoc web-hosted deploy:

```sh
cp .env.deploy.example .env.deploy
docker compose --env-file .env.deploy -f docker-compose.deploy.yml up --build -d
```

Hosted deployment is currently documented as a public read-only instance that can sit behind an existing VPS reverse proxy, with an optional bundled Caddy profile in the deploy compose. For the exact env contract, routing shape, and manual admin model, see:

- `docs/deploy/01-web-hosted-read-only.md`

Desktop runtime configuration is managed from the native Admin UI `config` section.
The Rust app embeds `config/settings.manifest.toml` as the Admin config schema/default source, stores only operator overrides in a versioned app-data JSON file, and renders the runtime `.env` from effective manifest defaults plus overrides only after the operator chooses defaults, saves configuration, or launches from saved configuration.
A stale `.env` without `settings.json` is treated as an inactive legacy file: Admin can show that it exists, but the supervisor will not boot from it.
On first launch, Admin can populate an empty `RPC_URL_LIST` automatically by benchmarking the embedded Chainlist Ethereum HTTP RPC payload. The config form also exposes manual Chainlist benchmark actions and a tracking-policy selector before the generated endpoint list is saved.

Rendered desktop runtime env file:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\.env`

Versioned Admin settings file:

- Linux: `~/.local/share/network.artgod.desktop/config/settings.json`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/settings.json`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\settings.json`

Desktop-first path defaults:

- `ARTGOD_DB_PATH=sqlite/main/db` (resolved relative to app-data dir unless absolute)
- `USERLAND_UI_DIST_DIR=frontend/userland` (resolved relative to desktop runtime resources dir unless absolute)
- `OPENSEA_INTEGRATION_MODE=auto` (OpenSea workers start only when `OPENSEA_API_KEY` is configured)

VSCode (Yarn PnP):

```sh
yarn dlx @yarnpkg/sdks vscode
```

## Versioning

The canonical project version lives in the root [`package.json`](package.json) `version` field.

When you bump the version, update it there first, then run:

```sh
yarn sync:version
```

That propagates the root version into the places that require materialized version fields:

- workspace `package.json` files
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `docs/backend-api.openapi.yaml`

Notes:

- The frontend build reads the app version directly from the root workspace version. There is no separate app-version deploy env override.
- Desktop release tags should match the root version with a leading `v`, for example root `0.0.1-pre-alpha.3` -> tag `v0.0.1-pre-alpha.3`.
- Run `yarn sync:version` before building release artifacts or pushing a release tag so Tauri, Cargo, workspace manifests, and OpenAPI stay aligned.

## Local Development

Start local infra (NATS + JetStream):

```sh
docker compose up -d
```

Start optional observability stack (Grafana + Loki + Alloy + Prometheus + Tempo + Pyroscope):

```sh
yarn observability:up
```

Use `yarn observability:stop` to stop those containers and
`yarn observability:down` to remove only those observability service containers.

Open Grafana at `http://localhost:42735` (default `admin` / `admin`).

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
yarn workspace @artgod/indexer run dev:offchain-ingest-worker
yarn workspace @artgod/indexer run dev:opensea-stream-worker
yarn workspace @artgod/indexer run dev:opensea-bootstrap-worker
yarn workspace @artgod/indexer run dev:opensea-reconcile-worker
yarn workspace @artgod/indexer run dev:opensea-reconcile-scheduler-worker
yarn workspace @artgod/indexer run dev:dead-letter-worker
```

## Desktop Release Builds

Desktop release artifacts are built publicly in GitHub Actions.

- Main release workflow: `.github/workflows/tauri-release.yml`
- Reproducibility workflow: `.github/workflows/tauri-repro-check.yml` (unsigned Linux parity)
- Trigger: push tag `v*` (for example `v0.1.0`)
- Targets: Linux x64, Windows x64, macOS universal
- Outputs: signed release bundles, `SHA256SUMS.txt`, `SHA256SUMS.txt.asc`, Linux detached signatures, and GitHub build provenance attestation

Keep the release tag aligned with the root `package.json` version as described in `Versioning` above.

For all desktop release details (signing/notarization setup, required secrets, verification commands, and CI flow), see:

- `docs/desktop/01-tauri-build-and-runtime.md`

For the current hosted Docker deployment shape (public reads, local-only writes, external shared proxy or optional bundled Caddy), see:

- `docs/deploy/01-web-hosted-read-only.md`

Desktop executable lifecycle:

1. Rust app process initializes and exposes runtime commands (startup is deferred; no immediate supervisor auto-start in `setup`).
2. System tray is initialized with native actions: `open ArtGod in browser`, `open admin UI`, `shutdown`.
3. Admin UI runs in the native Tauri window and exposes the privileged desktop control plane (`config`, `system`, `wallets`, `bots` + logs/open/stop/shutdown actions).
4. Userland UI runs in a regular browser tab and is served by the local backend origin.
5. Frontend boot lifecycle orchestrator initializes, waits for Tauri bridge readiness, then invokes `runtime_auto_start`; unconfigured installs and installs with `autostart infra` disabled stay stopped behind the Admin header action sequence.
6. When startup is requested, the supervisor starts local NATS from bundled `nats-server`, then backend, then enabled indexer workers from bundled resources (`resources/runtime/backend/dist-desktop/*.mjs`, `resources/runtime/indexer/dist-desktop/*.mjs`) using bundled Node + Yarn PnP hooks; OpenSea workers are skipped when OpenSea integration is disabled, and wallet-bound trading bots are staged too but start only on explicit operator action after unlock.
7. Boot lifecycle console stays visible until lifecycle backend readiness probe succeeds (not merely until process state is `running`).
8. Any core composition process exit triggers fail-fast full stack restart; wallet-bound trading bots are supervised separately and stop only when they crash or when one of their declared critical dependencies becomes unhealthy.
9. Closing the admin window hides it (runtime keeps running in tray). Graceful runtime shutdown is triggered explicitly via tray `shutdown` or app exit.

If your desktop config file was generated before runtime-artifact keys were added, open Admin `config`, review settings, and save to render the current `.env` shape:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\.env`

Trigger collection bootstrap (`metadata-mode` defaults to `best_effort`).
The trigger calls the backend bootstrap API, probes the contract first, applies
the same extension/image-cache suggestion the frontend form would submit, then
creates the durable run through the backend step planner. Run it only while the
backend is in an admin-capable deployment mode; public single-collection mode
does not register bootstrap write routes.

```sh
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --metadata-mode strict
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --metadata-mode best_effort
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --slug <slug> --opensea-slug <opensea-slug> --metadata-mode strict
```

Inside the deploy `backend` container, the trigger defaults to the local backend
listener at `http://127.0.0.1:<BACKEND_PORT>`. Use `--backend-origin` only when
calling a different backend origin.

Trigger manual historical backfill from CLI:

```sh
yarn workspace @artgod/indexer run dev:backfill-trigger --from-block <n> --to-block <n> [--collection-id <id>] [--batch-size <n>]
```

## Configuration

Create env files:

```sh
yarn config:check
cp .env.example .env
cp .env.test.example .env.test
```

`.env.example`, `.env.deploy.example`, and `shared/config/generated-settings-defaults.ts` are generated from `config/settings.manifest.toml`. Edit the manifest first, then run `yarn config:generate` and commit the manifest plus generated files together. See `docs/desktop/04-settings-manifest-process.md` for the full process.

The generated `.env.example` is the local web/indexer development baseline.
Keep deploy-only and desktop-only values such as `INTERNAL_BACKEND_ORIGIN` and `USERLAND_UI_DIST_DIR` blank there unless local dev is intentionally serving a built static userland bundle.
Hosted Docker deploy values belong in generated `.env.deploy.example`; desktop runtime values come from manifest desktop defaults and Admin-rendered app-data env.

Required core env:

```sh
ARTGOD_DB_PATH=database/sqlite/main/db
BACKEND_HOST=127.0.0.1
RPC_URL_LIST=[{"url":"http://127.0.0.1:42721","weight":1}]
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63
```

Useful optional env groups:

- Backend HTTP/security (`BACKEND_HOST`, `BACKEND_ALLOWED_HOSTS`, `BACKEND_ALLOWED_ORIGINS`, `BACKEND_CSRF_COOKIE_SECURE`, `PUBLIC_BACKEND_ORIGIN`)
- Backend query cache (`BACKEND_QUERY_CACHE_PROVIDER`, `BACKEND_PUBLIC_COLLECTION_*`, `BACKEND_QUERY_CACHE_TOKEN_PREVIEW_*`)
- Observability signal-store endpoints (`OBSERVABILITY_OTLP_HTTP_URL`, `OBSERVABILITY_PYROSCOPE_URL`)
- Backend observability (`BACKEND_METRICS_*`, `BACKEND_APM_*`)
- RPC endpoint pools and resilience (`RPC_URL_LIST`, `RPC_BACKFILL_URL_LIST`, `RPC_HTTP_REQUEST_TIMEOUT_MS`, `RPC_RETRY_*`, `RPC_RATE_LIMIT_*`, `RPC_CIRCUIT_BREAKER_*`)
- Metadata and bootstrap media tuning (`METADATA_REFRESH_RANGE_CHUNK_SIZE`, `BOOTSTRAP_METADATA_*`, `BOOTSTRAP_IMAGE_CACHE_*`)
- IPFS/media cache and HTTP fetch resilience (`COMMON_IPFS_GATEWAY_ORIGIN`, `COMMON_MEDIA_CACHE_DIR`, `COMMON_HTTP_FETCH_*`)
- Offchain storage (`OFFCHAIN_PERSIST_RAW_OBSERVATIONS`)
- Debug payload storage (`PERSIST_RAW_DEBUG_PAYLOADS`)
- OpenSea integration (`OPENSEA_INTEGRATION_MODE`, `OPENSEA_API_KEY`)
- Trading bot OpenSea lanes (`OPENSEA_STREAM_SECRET_KEY`, `OPENSEA_BIDDING_SECRET_KEY`, `OPENSEA_SNAPSHOT_SECRET_KEY`)
- Trading bot command reconciliation and bid-book freshness/live refresh (`BIDDING_COMMAND_*`, `BIDDING_BID_BOOK_*`, `BIDDING_RUNTIME_HEARTBEAT_*`)
- Trading bot transaction policy (`BIDDING_TX_MIN_PRIORITY_FEE_GWEI`, `BIDDING_TX_FEE_HISTORY_*`, `BIDDING_TX_BASE_FEE_MULTIPLIER`, `BIDDING_TX_MAX_FEE_GWEI`, `BIDDING_TX_PENDING_NONCE_POLICY`)
- Indexer metrics (`INDEXER_METRICS_ENABLED`, `INDEXER_METRICS_HOST`, `INDEXER_METRICS_PORT_*`)
- Indexer APM (`INDEXER_APM_ENABLED`, `INDEXER_APM_*`)

See `config/settings.manifest.toml`, the generated `.env.example`, generated `.env.deploy.example`, `shared/config/generated-settings-defaults.ts`, `docs/desktop/04-settings-manifest-process.md`, and `docs/indexer/01-config-and-env.md` for full definitions.

`BACKEND_QUERY_CACHE_PROVIDER=memory` enables a lightweight in-memory cache for expensive backend read queries. The current cached paths are:

- the default collection browser request for the public collection page (`listed`, first page, no filters)
- the token preview modal endpoint, default media mode only, with stale-while-revalidate warmup from the default collection page

Leave it `disabled` for local/admin setups unless you explicitly want that behavior.

## Architecture Overview

Core components:

1. Tauri desktop wrapper (`src-tauri/`)
2. Backend API (`backend/`)
3. Frontend UI (`frontend/`)
4. Indexer runtimes (`indexer/src/runtime/`)
5. Trading runtimes (`trading/src/runtime/`)
6. Shared database utilities (`shared/database/`)
7. SQLite migrations (`database/migrations/`)
8. Queue broker (NATS JetStream)

### Indexer Runtime Topology

Runtime entrypoints:

- `indexer/src/runtime/scheduler-worker.ts`
- `indexer/src/runtime/sync-worker.ts`
- `indexer/src/runtime/reorg-worker.ts`
- `indexer/src/runtime/domain-worker.ts`
- `indexer/src/runtime/bootstrap-worker.ts`
- `indexer/src/runtime/collection-extension-worker.ts`
- `indexer/src/runtime/offchain-ingest-worker.ts`
- `indexer/src/runtime/opensea-stream-worker.ts`
- `indexer/src/runtime/opensea-bootstrap-worker.ts`
- `indexer/src/runtime/opensea-reconcile-worker.ts`
- `indexer/src/runtime/opensea-reconcile-scheduler-worker.ts`
- `indexer/src/runtime/dead-letter-worker.ts`

Queue contracts (`indexer/src/domain/queues.ts`):

- `events-sync-realtime`
- `events-sync-backfill`
- `block-check`
- `collection-bootstrap`
- `collection-bootstrap-image-cache`
- `opensea-bootstrap`
- `opensea-reconcile`
- `offchain-orders-raw`
- `orders-domain`
- `orders-upsert`
- `order-updates-by-maker`
- `order-updates-by-id`
- `collection-extension-artifacts`
- `metadata-domain`
- `metadata-refresh`
- `metadata-stats`
- `activity-domain`
- `dead-letter`

### Core Invariants

1. Scheduler-worker is the only publisher of realtime sync jobs.
2. Job handling is idempotent and assumes at-least-once delivery.
3. No implicit full historical backfill runs on startup.
4. Runtime logic depends on ports (`indexer/src/ports/`); infra adapters live in `indexer/src/infra/`.
5. Configuration is explicit and loaded through typed env loaders.
6. Collection extensions are build-bundled and DB-activated; canonical metadata remains authoritative and extension artifact jobs are non-blocking side-effects.

### Bootstrap Lifecycle

Per-collection bootstrap flow:

1. Register collection (`status = bootstrapping`), or start from a prepared row such as the first-launch Terraforms preset.
2. Pick anchor block (`head - reorgDepth`).
3. Auto-install any embedded collection extension whose build-bundled match exactly fits the collection contract plus token scope.
4. Run metadata snapshot first (strict or `best_effort` mode).
5. Enqueue a canonical metadata stats checkpoint once the metadata snapshot completes.
6. Fan out collection-extension artifact refresh jobs as non-blocking side-effects behind canonical metadata writes.
7. Start canonical token `image` media caching on its own bootstrap runtime lane when requested.
8. Run taskized ownership snapshot at the same anchor.
9. Schedule short backfill (`anchor + 1` to head).
10. Enqueue OpenSea bootstrap once local metadata + ownership are ready, only when OpenSea integration is enabled and the collection has an OpenSea slug.
11. Mark collection `live` once ownership and short backfill complete.
12. Let image cache, extension artifacts, and OpenSea converge as non-blocking side lanes; OpenSea `ready` is marked once the first full snapshot succeeds, or later through the collection-table `start opensea sync` action after OpenSea credentials are configured.

`nft_balances` is canonical ownership state after bootstrap completion.
Historical backfill for blocks at or before the bootstrap anchor is facts-only: it can enrich transfers/fills/activity history, but it must not mutate current-state tables such as `nft_balances`.

## Project Structure

- `backend/` Node.js API server (TypeScript, ESM)
- `frontend/` SvelteKit UI (Tailwind, Vite)
- `indexer/` runtime workers, domain logic, infra adapters, tests
- `trading/` wallet-bound bot runtimes and stdin secret-envelope bootstrap
- `shared/` shared TypeScript utilities and database access
- `database/` SQLite migrations and storage roots
- `observability/` Grafana/Loki/Tempo/Pyroscope/Alloy provisioning
- `scripts/` local development scripts
- `src-tauri/` Tauri desktop wrapper
- `docs/` architecture, blueprint references, progress/backlog

## Database & Migrations

- SQLite file path is required via `ARTGOD_DB_PATH`.
- Token image cache files live under `COMMON_MEDIA_CACHE_DIR` when set, otherwise beside the SQLite database under `media-cache/token-images`.
- Migrations live in `database/migrations/*.sql`.
- Migrations are applied automatically by runtime startup paths via `shared/database/migrations.ts`.
- Append-only migrations may seed prepared collection rows; the current fresh-install preset is Terraforms collection ID 1 with no out-of-box token or run data.

## Observability

Signal paths:

- Logs: runtime file logs -> Alloy -> Loki -> Grafana
- Metrics: backend/indexer `/metrics` endpoints -> Prometheus -> Grafana
- Traces: backend/indexer OTLP -> Tempo -> Grafana
- Profiles: Pyroscope -> Grafana

The public deploy compose exposes the same stack behind its `observability` profile, with Grafana published only on the configured private host bind such as `http://10.77.0.1:42735`.

Reference docs:

- `docs/indexer/10-observability-and-metrics.md`
- `docs/rpc/01-http-rpc-interaction-catalog.md`
- `docs/progress/indexer/16-trace-profile-linking-plan.md`

## Canonical Docs

Use these as primary references for design and implementation details:

- `docs/indexer/00-overview.md` through `docs/indexer/17-bootstrap-concurrency-audit.md`
- `docs/extensions/01-collection-extensions.md`
- `docs/desktop/01-tauri-build-and-runtime.md`
- `docs/desktop/02-runtime-registry-maintenance.md`
- `docs/desktop/03-wallet-keystore-and-bot-unlock.md`
- `docs/desktop/04-settings-manifest-process.md`
- `docs/ports/01-port-catalog.md`
- `docs/rpc/01-http-rpc-interaction-catalog.md`
- `docs/trading/01-bidding-runtime-and-jobs.md`
- `docs/trading/02-bidding-automation-capabilities.md`
- `docs/progress/trading/01-bidder-integration-plan.md`
- `docs/progress/trading/02-db-backed-trading-jobs-plan.md`
- `docs/progress/desktop/01-wallet-keystore-implementation-plan.md`
- `docs/progress/desktop/02-local-runtime-identity-and-browser-trust.md`
- `docs/deploy/01-web-hosted-read-only.md`
- `docs/diagrams/architecture.md`
- `docs/progress/indexer/15-unified-backlog.md`
- `docs/ui/01-interaction-guidelines.md`
- `docs/ui/02-preview-modal-system.md`

Blueprint/reference material:

- `docs/blueprint/*.md`

## Common Commands

```sh
# Start backend, indexer launcher, and frontend dev server.
yarn dev

# Start the desktop dev shell after the desktop dev staging sequence in Quick Start.
cargo tauri dev

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
