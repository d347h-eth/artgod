# ArtGod

Local-first desktop app for NFT trading and indexing. All services run on your machine (no centralized server).

## Quick Start

```sh
yarn install
yarn dev
```

Optional desktop shell:

```sh
cargo tauri dev
```

VSCode (Yarn PnP):

```sh
yarn dlx @yarnpkg/sdks vscode
```

## Local Development

Start local infra (NATS + JetStream):

```sh
docker compose up -d
```

Create your env file:

```sh
cp .env.example .env
```

For tests (smoke):

```sh
cp .env.test.example .env.test
```

Set the SQLite path (required):

```sh
# Example
ARTGOD_DB_PATH=database/sqlite/main/db
```

Set WETH address (required for bid re-validation triggers):

```sh
# Mainnet WETH
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
```

Metadata batch refresh chunk size (used for ERC-4906 batch updates):

```sh
METADATA_REFRESH_RANGE_CHUNK_SIZE=200
```

Bootstrap metadata snapshot tuning:

```sh
BOOTSTRAP_METADATA_BATCH_SIZE=200
BOOTSTRAP_METADATA_CONCURRENCY=8
BOOTSTRAP_METADATA_PROCESS_POLL_MS=5000
BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS=5
BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS=5000
BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS=300000
```

Optional RPC resilience tuning (rate limiter + circuit breaker):

```sh
RPC_RETRY_MAX_ATTEMPTS=5
RPC_RETRY_BASE_DELAY_MS=100
RPC_RETRY_MAX_DELAY_MS=3000
RPC_RATE_LIMIT_REQUESTS_PER_SECOND=50 # use 0 to disable rate limiting
RPC_RATE_LIMIT_BURST=100
RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
RPC_CIRCUIT_BREAKER_OPEN_MS=5000
RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS=2
```

Then run indexer runtimes as needed:

```sh
yarn workspace @artgod/indexer run dev:scheduler
yarn workspace @artgod/indexer run dev:sync-worker
yarn workspace @artgod/indexer run dev:bootstrap-worker
```

Trigger collection bootstrap (metadata mode defaults to `strict`):

```sh
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --metadata-mode strict
yarn workspace @artgod/indexer run dev:bootstrap-trigger --address <0x...> --metadata-mode best_effort
```

## Project Structure

- `backend/` Node.js API server (TypeScript, ESM)
- `frontend/` SvelteKit UI (Tailwind, Vite)
- `shared/` shared TypeScript utilities and database access
- `database/` SQLite file + SQL migrations
- `indexer/` blockchain indexing worker
- `src-tauri/` Tauri desktop wrapper
- `scripts/` dev scripts

## Database

- SQLite file: `ARTGOD_DB_PATH` (required)
- Migrations: `database/migrations/*.sql`
- Migrations run on backend startup

## Common Commands

```sh
yarn dev
yarn workspace @artgod/backend run dev
yarn workspace @artgod/frontend run dev
yarn workspace @artgod/indexer run dev
```
