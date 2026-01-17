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

Then run indexer runtimes as needed:

```sh
yarn workspace @artgod/indexer run dev:scheduler
yarn workspace @artgod/indexer run dev:sync-worker
```

## Project Structure

-   `backend/` Node.js API server (TypeScript, ESM)
-   `frontend/` SvelteKit UI (Tailwind, Vite)
-   `shared/` shared TypeScript utilities and database access
-   `database/` SQLite file + SQL migrations
-   `indexer/` blockchain indexing worker
-   `src-tauri/` Tauri desktop wrapper
-   `scripts/` dev scripts

## Database

-   SQLite file: `ARTGOD_DB_PATH` (required)
-   Migrations: `database/migrations/*.sql`
-   Migrations run on backend startup

## Common Commands

```sh
yarn dev
yarn workspace @artgod/backend run dev
yarn workspace @artgod/frontend run dev
yarn workspace @artgod/indexer run dev
```
