# Configuration and Environment

This document describes the explicit configuration model used by the indexer and how environment variables are loaded into runtime config objects.

## Runtime Config Loader

Config is loaded in `indexer/src/config/index.ts` (sync/scheduler/domain workers) and `indexer/src/config/offchain.ts` (offchain stream worker). There are no scattered `process.env` reads in runtime logic; values are pulled once and passed through.

- `.env` is loaded at startup via `dotenv`.
- `loadConfig()` reads the current environment and produces a typed config object.
- Errors are thrown immediately for missing required values.

- `IndexerConfig`:
    - `chainId`
    - `rpc`: `primaryUrl`, optional `backfillUrl`, optional `wsUrl`
    - `tokens`: `wethAddress`
    - `queue`: NATS URL and stream prefix
    - `sync`: reorg depth, backfill batch size, log chunk size
    - `cache`: max entries and TTL
    - collections are stored in SQLite (`collections` table), not in env

## Environment Variables (.env)

The indexer reads these variables from the root `.env`:

- `ARTGOD_DB_PATH` (required)
    - Path to SQLite file. Relative paths are resolved from repo root.
- `CHAIN_ID` (default: 1)
- `RPC_URL` (required)
- `RPC_BACKFILL_URL` (optional)
- `RPC_WS_URL` (optional)
- `WETH_ADDRESS` (required)
- `NATS_URL` (default: `nats://127.0.0.1:4222`)
- `NATS_STREAM_PREFIX` (default: `artgod`)
- `REORG_DEPTH` (default: 20)
- `BACKFILL_BATCH_SIZE` (default: 50)
- `LOG_CHUNK_SIZE` (default: 2000)
- `CACHE_MAX_ENTRIES` (default: 5000)
- `CACHE_TTL_MS` (default: 30000)

`RPC_BACKFILL_URL`, when set, is used by backfill sync jobs; realtime sync continues to use `RPC_URL`.

### Offchain Stream (.env)

The OpenSea stream stub uses a separate config loader (`indexer/src/config/offchain.ts`) and requires:

- `OPENSEA_STREAM_MODE` (required, current supported value: `fixtures`)
- `OPENSEA_FIXTURES_DIR` (required, directory with JSON payloads)
- `OPENSEA_FIXTURE_DELAY_MS` (optional, delay between fixture events)

Example (from `.env.example`):

```
ARTGOD_DB_PATH=database/sqlite/main/db
CHAIN_ID=1
RPC_URL=http://127.0.0.1:8545
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
NATS_URL=nats://127.0.0.1:4222
NATS_STREAM_PREFIX=artgod
REORG_DEPTH=32
BACKFILL_BATCH_SIZE=50
LOG_CHUNK_SIZE=2000
CACHE_MAX_ENTRIES=5000
CACHE_TTL_MS=30000
OPENSEA_STREAM_MODE=fixtures
OPENSEA_FIXTURES_DIR=indexer/tests/fixtures/opensea-event-payloads
OPENSEA_FIXTURE_DELAY_MS=0
```

## Test Environment (.env.test)

The smoke tests use a separate `.env.test` file loaded by `indexer/tests/helpers/test-env.ts`. This file is required to run smoke tests and must include:

- `ARTGOD_DB_PATH` (required)
- `SMOKE_NATS_PORT` (required, host port for the NATS container)
- `SMOKE_RPC_URL` (required)
- `WETH_ADDRESS` (required)
- `SMOKE_TARGET_COLLECTIONS` (required JSON string)
- `SMOKE_RANGE_FROM` (required)
- `SMOKE_RANGE_TO` (required)
- `SMOKE_CHAIN_ID` (optional, default 1)

`SMOKE_TARGET_COLLECTIONS` is used to seed the `collections` table before the smoke test runs.

Example (from `.env.test.example`):

```
ARTGOD_DB_PATH=database/sqlite/test/db
SMOKE_NATS_PORT=10247
SMOKE_RPC_URL=http://127.0.0.1:8545
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
SMOKE_TARGET_COLLECTIONS='[{"id":"terraforms","address":"0x4E1f41613c9084FdB9E34E11fAE9412427480e56","deploymentBlock":13823015}]'
SMOKE_RANGE_FROM=24193425
SMOKE_RANGE_TO=24193425
SMOKE_CHAIN_ID=1
```

## Database Path Resolution

`@artgod/shared/database` enforces `ARTGOD_DB_PATH` as a required env variable. If it is missing, the runtime throws immediately.

- Absolute paths are used as-is.
- Relative paths are resolved from the repo root.
- The database file directory is created if it does not exist.
- SQLite is configured with WAL mode, normal synchronous, and a busy timeout.

See `shared/database/db.ts` for details.
