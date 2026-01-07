# AGENTS.md

This file provides guidance to LLMs when working with code in this repository.

## Project Overview

ArtGod is a cross-platform desktop application for blockchain NFT trading and indexing. The project is in early development phase with only backend scaffolding currently present.

**Important**: ArtGod is designed as strictly local-focused, peer-to-peer software with no centralized server infrastructure. All processes run locally on the user's machine.

## Architecture

The application follows a multi-component architecture:

1. **Tauri** - Cross-platform distribution layer that packages all components into a desktop app binary
2. **Node.js Backend** - API server, event streaming via SSE, and worker process management
3. **Svelte Frontend** - Web UI served by backend and opened in native browser at localhost:427906
4. **SQLite (better-sqlite3)** - Local database for migrations, user settings, contracts/projects data, and worker jobs

### Key Components

- **Backend API** (`backend/`): Node.js server with TypeScript, serves frontend and provides data APIs
- **Indexer Worker**: For blockchain data processing
- **Configuration**: Native OS window for immediate access to app settings
- **Future Trading Worker**: Integration with NFT marketplaces (Seaport OS, Blur, Payment Processor)

## Development Setup

### Development Commands
```bash
# Install all workspace dependencies
yarn install

# Start all components in development mode
yarn dev

# Start desktop app with all components
cargo tauri dev

# Individual component development
cd backend && yarn dev    # API server with database
cd frontend && yarn dev   # Svelte app  
cd indexer && yarn dev    # worker for blockchain indexing (no-op currently)
```

### Technology Stack
- TypeScript with ES2022 target and Node.js ESM modules
- Yarn package manager with PnP (Plug'n'Play) mode and workspaces
- SQLite via better-sqlite3 for local embedded database
- Custom SQL migration system with automatic execution
- SvelteKit frontend with Tailwind CSS
- Tauri for cross-platform desktop distribution
- Indexer for blockchain indexing (planned)

## Project Structure

```
ArtGod/
├── src-tauri/                    # Tauri Rust desktop application
│   ├── src/                      # Rust source code
│   ├── Cargo.toml
│   └── tauri.conf.json           # Tauri configuration
├── backend/                      # Node.js API server
│   ├── src/index.ts              # Main server entry point
│   ├── build/                    # Compiled JavaScript output
│   ├── package.json
│   └── tsconfig.json
├── frontend/                     # SvelteKit web application  
│   ├── src/{lib,routes,stores}/  # Svelte components and pages
│   ├── dist/                     # Built frontend assets
│   ├── package.json
│   └── vite.config.ts
├── indexer/                      # Blockchain indexer
│   └── package.json              # No-op placeholder currently
├── shared/                       # Shared TypeScript utilities
│   ├── build/                    # Compiled shared modules
│   ├── database/                 # Database connection and migrations
│   │   ├── db.ts                 # sqlite connection singleton
│   │   └── migrations.ts         # Migration runner
│   ├── utils/                    # Shared utility functions
│   └── package.json
├── database/                     # Database infrastructure
│   ├── artgod.sqlite             # SQLite database file (auto-generated)
│   ├── migrations/               # SQL schema migration files
│   │   └── 001_initial_schema.sql
│   └── package.json
├── scripts/                      # Development scripts
│   └── dev.sh                    # Concurrent startup script
├── package.json                  # Root workspace configuration
├── tsconfig.json                 # Root TypeScript project references
└── yarn.lock                     # Dependency lockfile
```

## Target Features

### Core Functionality
- Ethereum JSON-RPC gateway management
- Blockchain data indexing for specific NFT projects (Terraforms, WCSG, Angelus)
- Real-time blockchain synchronization
- Data export/import for faster setup

### Trading Features (Future)
- Multi-marketplace integration (Seaport OS, Blur)
- Bidding strategies (single/multiple IDs, collections, traits)
- Listing and sniping functionality
- Secure wallet management

### Notifications
- In-app and OS notifications
- Third-party integrations (Telegram, Discord)

## Database & Migration Management

### Database Architecture
The project uses **SQLite (better-sqlite3)** as a single shared database:

- **`./database/artgod.sqlite`** - Actual SQLite database file (auto-generated)
- **`./database/migrations/`** - SQL schema migration files
- **`./shared/database/`** - Runtime connection singleton and migration runner
- **Automatic migrations** - Run on backend startup via `shared/database/migrations.ts`

### Migration Workflow
1. Create numbered SQL files in `database/migrations/` (e.g., `002_add_users.sql`)
2. Migrations run automatically when backend starts
3. Migration tracking table prevents duplicate execution
4. All components share the same database instance

### Usage Pattern
```typescript
// Import database in any component
import { db } from '@artgod/shared/database';

// Execute queries
const result = db.prepare('SELECT * FROM projects').all();
```

## Development Notes

- **Yarn PnP enabled** with proper workspace TypeScript project references
- **All components functional** with shared sqlite database
- **Backend** runs TypeScript with tsx, includes automatic migrations
- **Frontend** uses SvelteKit with Tailwind CSS and Vite
- **Desktop app** packages all components via Tauri
- **Indexer** is placeholder (no-op)
- **Core focus** is on Ethereum NFT data indexing and trading automation

## Coding Guidelines

- Keep top-level runtime flows linear and readable: separate distinct business actions into named helpers.
- Avoid mixing unrelated concerns inside a single block; use whitespace and clear names to show intent.
- Follow KISS/DRY/SOLID both across components and within a function body.

## Architecture Constraints

- **No centralized servers**: All functionality must be self-contained within the desktop application
- **Local-only operation**: Backend API, workers, and database run entirely on user's machine
- **P2P design**: Any network communication should be direct peer-to-peer or with public blockchain/marketplace APIs
- **Offline capability**: Core functionality should work without internet connectivity where possible
- **Distribution**: Updates and data sharing must work without proprietary server infrastructure
