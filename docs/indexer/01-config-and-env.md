# Configuration and Environment

This document describes the explicit configuration model used by the indexer and how environment variables are loaded into runtime config objects. Default values are manifest-sourced from `config/settings.manifest.toml` through `shared/config/generated-settings-defaults.ts`; update the manifest and regenerate artifacts instead of editing fallback literals in config modules.

## Runtime Config Loader

Config is loaded in `indexer/src/config/index.ts` (core indexer workers) and `indexer/src/config/opensea.ts` (OpenSea bootstrap/stream/reconcile workers). Backend uses `backend/src/config.ts`, and shared integration capability semantics live in `shared/config/opensea-integration.ts`. There are no scattered `process.env` reads in runtime logic; values are pulled once and passed through.

- `.env` is loaded at startup via `dotenv`.
- `loadConfig()` reads the current environment and produces a typed config object.
- Errors are thrown immediately for missing required values. Optional integrations are represented as typed capability state instead of implicit defaults.

- `IndexerConfig`:
    - `chainId`
    - `rpc`: weighted HTTP endpoint pool, optional weighted backfill endpoint pool, optional weighted WebSocket endpoint pool
    - `tokens`: `wethAddress`
    - `queue`: NATS URL and stream prefix
- `sync`: reorg depth, backfill batch size, backfill worker count, log chunk size
- `cache`: max entries and TTL
- `offchain`: raw observation persistence toggle
- collections are stored in SQLite (`collections` table), not in env

## Environment Variables (.env)

The indexer reads these variables from the root `.env`:

- `ARTGOD_DB_PATH` (required)
    - Path to SQLite file. Relative paths are resolved from repo root.
- `CHAIN_ID` (default: 1)
- `RPC_URL_LIST` (required)
    - HTTP JSON-RPC endpoint pool used by backend, indexer, and trading runtimes.
    - Supply a JSON array of endpoint objects, for example `[{"url":"https://rpc-a.example","weight":2},{"url":"https://rpc-b.example","weight":1}]`.
    - `weight` is optional and defaults to `1`.
    - Desktop Admin can generate this list by benchmarking the embedded or
      locally refreshed Chainlist Ethereum HTTP RPC payload before startup.
- `RPC_BACKFILL_URL_LIST` (optional)
    - Optional JSON array of weighted HTTP JSON-RPC endpoints used by backfill sync jobs.
- `RPC_WS_URL_LIST` (optional)
    - Optional JSON array of weighted WebSocket RPC endpoints used by the scheduler as a single-active new-head listener with fallback.
- `WETH_ADDRESS` (required)
- `NATS_URL` (default: `nats://127.0.0.1:42720`)
- `NATS_STREAM_PREFIX` (default: `artgod`)
- `REORG_DEPTH` (default: 32)
- `BACKFILL_BATCH_SIZE` (default: 50)
- `BACKFILL_WORKER_COUNT` (default: 1)
    - Controls how many backfill sync jobs may be in flight in the sync worker.
    - Only fully pre-anchor facts-only ranges run concurrently; ranges that may touch current state are serialized by the worker.
- `LOG_CHUNK_SIZE` (default: 2000)
- `CACHE_MAX_ENTRIES` (default: 5000)
- `CACHE_TTL_MS` (default: 30000)
- `BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS` (default: 60000)
    - Public single-collection blockspace cache rebuild cadence when backend query caching is enabled.
- `OFFCHAIN_PERSIST_RAW_OBSERVATIONS` (default: `false`)
    - Controls whether `offchain-ingest-worker` persists raw OpenSea payloads into `offchain_order_observations`.
    - Set to `true` when raw audit payload history is needed.
- `ARTGOD_IPFS_GATEWAY_ORIGIN` (default: `https://ipfs.io`)
    - Dedicated origin used when resolving `ipfs://` metadata and token-image references.
    - `/ipfs` suffixes are accepted in config but normalized away before requests are built.
- `ARTGOD_MEDIA_CACHE_DIR` (optional)
    - Filesystem root for locally cached token images.
    - When omitted, resolves beside `ARTGOD_DB_PATH` as `../media-cache/token-images`.
- `BOOTSTRAP_SNAPSHOT_BATCH_SIZE` (default: 200)
- `BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE` (default: 50)
- `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY` (default: 4)
- `BOOTSTRAP_IMAGE_CACHE_MAX_SOURCE_BYTES` (default: 26214400)
- `SEAPORT_CONDUIT_CONTROLLER` (required)

`RPC_BACKFILL_URL_LIST`, when set, is used by backfill sync jobs; realtime sync continues to use `RPC_URL_LIST`.
Endpoint weights define the baseline request share. Runtime adapters lower an endpoint's effective weight after observed request failures and recover it after successful requests; these adjusted weights are process-local and are not persisted.

### OpenSea Integration Mode (.env)

OpenSea integration is controlled by `OPENSEA_INTEGRATION_MODE`:

- `auto` (default): OpenSea is enabled only when `OPENSEA_API_KEY` is present. Missing key disables OpenSea workers, OpenSea bootstrap, and OpenSea-dependent Admin bot starts without failing core backend/indexer startup.
- `enabled`: OpenSea is mandatory. Missing `OPENSEA_API_KEY` is a startup configuration error.
- `disabled`: OpenSea is intentionally disabled even if `OPENSEA_API_KEY` is present.

Backend exposes the resolved capability at `GET /api/runtime/config` so userland can disable OpenSea-only bootstrap fields. Desktop Rust resolves the same capability before supervisor composition and before Admin bot starts.

### OpenSea Offchain (.env)

The OpenSea workers use a separate config loader (`indexer/src/config/opensea.ts`) and require enabled OpenSea integration:

- `OPENSEA_INTEGRATION_MODE` (default: `auto`)
- `OPENSEA_API_KEY` (required when OpenSea integration is enabled)
- `OPENSEA_SNAPSHOT_PAGE_SIZE` (default: `100`)
- `OPENSEA_RECONCILE_INTERVAL_MS` (default: `900000`)
- `OPENSEA_STALE_START_THRESHOLD_MS` (default: `1800000`)
- `OPENSEA_STREAM_SUBSCRIPTION_POLL_MS` (default: `5000`)
- `OPENSEA_HTTP_RETRY_MAX_ATTEMPTS` (default: `3`)
- `OPENSEA_HTTP_RETRY_BASE_DELAY_MS` (default: `500`)
- `OPENSEA_HTTP_RETRY_MAX_DELAY_MS` (default: `10000`)
- `OPENSEA_HTTP_RETRY_JITTER_RATIO` (default: `0.2`)
- `OPENSEA_RATE_LIMIT_GET_MAX` (default: `4`)
- `OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND` (default: `1`)
- `OPENSEA_RATE_LIMIT_POST_MAX` (default: `2`)
- `OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND` (default: `0.5`)

Example (from `.env.example`):

```
ARTGOD_DB_PATH=database/sqlite/main/db
CHAIN_ID=1
RPC_URL_LIST=[{"url":"http://127.0.0.1:42721","weight":1}]
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
NATS_URL=nats://127.0.0.1:42720
NATS_STREAM_PREFIX=artgod
REORG_DEPTH=32
BACKFILL_BATCH_SIZE=50
BACKFILL_WORKER_COUNT=1
LOG_CHUNK_SIZE=2000
CACHE_MAX_ENTRIES=5000
CACHE_TTL_MS=30000
BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS=60000
OFFCHAIN_PERSIST_RAW_OBSERVATIONS=false
ARTGOD_IPFS_GATEWAY_ORIGIN=https://ipfs.io
ARTGOD_MEDIA_CACHE_DIR=
BOOTSTRAP_SNAPSHOT_BATCH_SIZE=200
BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE=50
BOOTSTRAP_IMAGE_CACHE_CONCURRENCY=4
BOOTSTRAP_IMAGE_CACHE_MAX_SOURCE_BYTES=26214400
SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63
OPENSEA_INTEGRATION_MODE=auto
OPENSEA_API_KEY=
OPENSEA_SNAPSHOT_PAGE_SIZE=100
OPENSEA_RECONCILE_INTERVAL_MS=900000
OPENSEA_STALE_START_THRESHOLD_MS=1800000
OPENSEA_STREAM_SUBSCRIPTION_POLL_MS=5000
OPENSEA_HTTP_RETRY_MAX_ATTEMPTS=3
OPENSEA_HTTP_RETRY_BASE_DELAY_MS=500
OPENSEA_HTTP_RETRY_MAX_DELAY_MS=10000
OPENSEA_HTTP_RETRY_JITTER_RATIO=0.2
OPENSEA_RATE_LIMIT_GET_MAX=4
OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND=1
OPENSEA_RATE_LIMIT_POST_MAX=2
OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND=0.5
```

## Test Environment (.env.test)

The smoke tests use a separate `.env.test` file loaded by `indexer/tests/helpers/test-env.ts`. This file is required to run smoke tests and must include:

- `ARTGOD_DB_PATH` (required)
- `SMOKE_NATS_PORT` (required, host port for the NATS container)
- `SMOKE_RPC_URL_LIST` (required)
- `WETH_ADDRESS` (required)
- `SMOKE_TARGET_COLLECTIONS` (required JSON string)
- `SMOKE_RANGE_FROM` (required)
- `SMOKE_RANGE_TO` (required)
- `SMOKE_CHAIN_ID` (optional, default 1)
- `SEAPORT_CONDUIT_CONTROLLER` (required)

`SMOKE_TARGET_COLLECTIONS` is used to seed the `collections` table before the smoke test runs.

Example (from `.env.test.example`):

```
ARTGOD_DB_PATH=database/sqlite/test/db
OPENSEA_INTEGRATION_MODE=auto
OPENSEA_API_KEY=test-opensea-api-key
SMOKE_NATS_PORT=42724
SMOKE_RPC_URL_LIST=[{"url":"http://127.0.0.1:42721","weight":1}]
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63
SMOKE_TARGET_COLLECTIONS='[{"id":"terraforms","address":"0x4E1f41613c9084FdB9E34E11fAE9412427480e56","deploymentBlock":13823015}]'
SMOKE_RANGE_FROM=24193425
SMOKE_RANGE_TO=24193425
SMOKE_CHAIN_ID=1
```

## Database Path Resolution

`ARTGOD_DB_PATH` is required by the app config loaders (`indexer/src/config/index.ts`, `backend/src/config.ts`). Runtime entrypoints pass this value into `@artgod/shared/database` via `setDbPath(...)` before migrations or repository/read-model usage.

- Absolute paths are used as-is.
- Relative paths are resolved from the repo root.
- The database file directory is created if it does not exist.
- SQLite is configured with WAL mode, normal synchronous, and a busy timeout.
- The default token-image cache directory is derived from this path, so database and local media can be moved together unless `ARTGOD_MEDIA_CACHE_DIR` overrides it.

See `shared/database/db.ts` for details.
