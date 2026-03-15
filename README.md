# ArtGod

Local-first desktop app for NFT indexing and trading workflows.
All core services run on the user's machine (no centralized ArtGod servers).

## Canonical Status

This `README.md` is the canonical human-facing project status document.

Current implementation snapshot:

- Multi-runtime indexer is active and queue-driven (NATS JetStream + SQLite).
- Realtime sync, backfill sync, and reorg checks are implemented.
- Collection bootstrap is implemented (metadata-first, then ownership snapshot + short backfill).
- Domain projections for orders, metadata, and activities are implemented.
- Offchain ingestion includes OpenSea live stream ingestion, bootstrap snapshots, periodic reconciliation, and normalization into canonical order state.
- Collection extensions are build-bundled and DB-activated; Terraforms is the first embedded extension for metadata-side artifacts, sync enrichment, and backend media overrides.
- Local observability stack is available (logs, metrics, traces, profiles).
- Tauri desktop runtime supervisor composes local NATS + backend + indexer workers from production runtime artifacts.

Canonical backlog and priorities live in `docs/progress/indexer/15-unified-backlog.md`.

## Quick Start

```sh
yarn install
yarn dev
```

Optional desktop shell:

```sh
cargo tauri dev
```

Local desktop build (no bundle):

```sh
yarn install --immutable
yarn tauri build --debug --no-bundle --ci
```

Build helper commands:

```sh
yarn build:web
yarn build:userland
yarn build:admin
yarn build:desktop
yarn build:runtime
yarn build:desktop-runtime-resources
yarn check:runtime-registry
yarn clean:build
```

Desktop runtime env file is generated on first launch at:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\.env`

Desktop-first path defaults:

- `ARTGOD_DB_PATH=sqlite/main/db` (resolved relative to app-data dir unless absolute)
- `USERLAND_UI_DIST_DIR=frontend/userland` (resolved relative to desktop runtime resources dir unless absolute)

VSCode (Yarn PnP):

```sh
yarn dlx @yarnpkg/sdks vscode
```

## Local Development

Start local infra (NATS + JetStream):

```sh
docker compose up -d
```

Start optional observability stack (Grafana + Loki + Alloy + Prometheus + Tempo + Pyroscope):

```sh
docker compose --profile observability up -d loki tempo pyroscope alloy prometheus grafana
```

Open Grafana at `http://localhost:42701` (default `admin` / `admin`).

Use the indexer launcher to produce runtime log files under `tmp/logs/*.log`:

```sh
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

For all desktop release details (signing/notarization setup, required secrets, verification commands, and CI flow), see:

- `docs/desktop/01-tauri-build-and-runtime.md`

Build helper commands:

```sh
yarn build:web                 # frontend web build only
yarn build:userland            # frontend userland static build (adapter-static -> frontend/dist-userland)
yarn build:admin               # frontend admin static build for Tauri window (adapter-static -> frontend/dist)
yarn build:desktop             # alias for build:admin
yarn build:runtime             # backend/indexer Node runtime artifacts
yarn build:desktop-runtime-resources # copies runtime artifacts + Yarn runtime deps + bundled Node+NATS runtimes (cached under .cache/desktop-*-runtime)
yarn check:runtime-registry    # validates runtime list consistency across build/supervisor/dev/observability
yarn clean:build               # clears dist and build caches across all workspaces
yarn tauri build --no-bundle --ci
yarn tauri build --debug --no-bundle --ci
```

Desktop executable lifecycle:

1. Rust app process initializes and exposes runtime commands (startup is deferred; no immediate supervisor auto-start in `setup`).
2. System tray is initialized with native actions: `open ArtGod in browser`, `open admin UI`, `shutdown`.
3. Admin UI runs in the native Tauri window and is limited to runtime operations (`lifecycle`, `logs`, `status` + browser-open action).
4. Userland UI runs in a regular browser tab and is served by the local backend origin.
5. Frontend boot lifecycle orchestrator initializes, waits for Tauri bridge readiness, then invokes `runtime_auto_start`.
6. Supervisor starts local NATS from bundled `nats-server`, then backend, then all indexer workers from bundled resources (`resources/runtime/backend/dist-desktop/*.mjs`, `resources/runtime/indexer/dist-desktop/*.mjs`) using bundled Node + Yarn PnP hooks; runtime status becomes `running` only after semantic backend health (`/health/runtime`) succeeds.
7. Boot lifecycle console stays visible until lifecycle backend readiness probe succeeds (not merely until process state is `running`).
8. Any core process exit triggers fail-fast full stack restart.
9. Closing the admin window hides it (runtime keeps running in tray). Graceful runtime shutdown is triggered explicitly via tray `shutdown` or app exit.

If your desktop config file was generated before runtime-artifact keys were added, either update it manually or delete it to regenerate:

- Linux: `~/.local/share/network.artgod.desktop/config/.env`
- macOS: `~/Library/Application Support/network.artgod.desktop/config/.env`
- Windows: `%APPDATA%\\network.artgod.desktop\\config\\.env`

Trigger collection bootstrap (`metadata-mode` defaults to `strict`):

```sh
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --metadata-mode strict
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --metadata-mode best_effort
```

## Configuration

Create env files:

```sh
cp .env.example .env
cp .env.test.example .env.test
```

Required core env:

```sh
ARTGOD_DB_PATH=database/sqlite/main/db
RPC_URL=http://127.0.0.1:8545
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63
```

Useful optional env groups:

- RPC resilience (`RPC_RETRY_*`, `RPC_RATE_LIMIT_*`, `RPC_CIRCUIT_BREAKER_*`)
- Metadata refresh/batch tuning (`METADATA_REFRESH_RANGE_CHUNK_SIZE`, `BOOTSTRAP_METADATA_*`)
- Metrics (`METRICS_ENABLED`, `METRICS_HOST`, `METRICS_PORT_*`)
- APM (`APM_ENABLED`, `APM_*`)

See `.env.example` and `docs/indexer/01-config-and-env.md` for full definitions.

## Architecture Overview

Core components:

1. Tauri desktop wrapper (`src-tauri/`)
2. Backend API (`backend/`)
3. Frontend UI (`frontend/`)
4. Indexer runtimes (`indexer/src/runtime/`)
5. Shared database utilities (`shared/database/`)
6. SQLite migrations (`database/migrations/`)
7. Queue broker (NATS JetStream)

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

1. Register collection (`status = bootstrapping`).
2. Pick anchor block (`head - reorgDepth`).
3. Auto-install any embedded collection extension for the collection contract.
4. Run metadata snapshot first (strict or `best_effort` mode).
5. Fan out collection-extension artifact refresh jobs as non-blocking side-effects behind canonical metadata writes.
6. Run ownership snapshot at the same anchor.
7. Schedule short backfill (`anchor + 1` to head).
8. Enqueue OpenSea bootstrap once local metadata + ownership are ready.
9. Mark collection `live` once short backfill completes.
10. Mark OpenSea offchain `ready` once the first full snapshot succeeds; periodic reconcile maintains eventual consistency after that.

`nft_balances` is canonical ownership state after bootstrap completion.

## Project Structure

- `backend/` Node.js API server (TypeScript, ESM)
- `frontend/` SvelteKit UI (Tailwind, Vite)
- `indexer/` runtime workers, domain logic, infra adapters, tests
- `shared/` shared TypeScript utilities and database access
- `database/` SQLite migrations and storage roots
- `observability/` Grafana/Loki/Tempo/Pyroscope/Alloy provisioning
- `scripts/` local development scripts
- `src-tauri/` Tauri desktop wrapper
- `docs/` architecture, blueprint references, progress/backlog

## Database & Migrations

- SQLite file path is required via `ARTGOD_DB_PATH`.
- Migrations live in `database/migrations/*.sql`.
- Migrations are applied automatically by runtime startup paths via `shared/database/migrations.ts`.

## Observability

Signal paths:

- Logs: runtime file logs -> Alloy -> Loki -> Grafana
- Metrics: per-runtime `/metrics` -> Prometheus -> Grafana
- Traces: OTLP -> Tempo -> Grafana
- Profiles: Pyroscope -> Grafana

Reference docs:

- `docs/indexer/10-observability-and-metrics.md`
- `docs/progress/indexer/16-trace-profile-linking-plan.md`

## Canonical Docs

Use these as primary references for design and implementation details:

- `docs/indexer/00-overview.md` through `docs/indexer/14-collection-bootstrap.md`
- `docs/desktop/01-tauri-build-and-runtime.md`
- `docs/desktop/02-runtime-registry-maintenance.md`
- `docs/diagrams/architecture.md`
- `docs/progress/indexer/15-unified-backlog.md`
- `docs/ui/01-interaction-guidelines.md`

Blueprint/reference material:

- `docs/blueprint/*.md`

## Common Commands

```sh
yarn dev
yarn workspace @artgod/backend run dev
yarn workspace @artgod/frontend run dev
yarn workspace @artgod/indexer run dev
yarn build:web
yarn build:desktop
yarn build:runtime
yarn build:desktop-runtime-resources
yarn check:runtime-registry
yarn clean:build
yarn tauri build --no-bundle --ci
```
