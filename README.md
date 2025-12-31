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

## Project Structure

- `backend/` Node.js API server (TypeScript, ESM)
- `frontend/` SvelteKit UI (Tailwind, Vite)
- `shared/` shared TypeScript utilities and database access
- `database/` SQLite file + SQL migrations
- `indexer/` blockchain indexing worker
- `src-tauri/` Tauri desktop wrapper
- `scripts/` dev scripts

## Database

- SQLite file: `database/sqlite/sqlite` (auto-generated)
- Migrations: `database/migrations/*.sql`
- Migrations run on backend startup

## Common Commands

```sh
yarn dev
yarn workspace @artgod/backend run dev
yarn workspace @artgod/frontend run dev
yarn workspace @artgod/indexer run dev
```
