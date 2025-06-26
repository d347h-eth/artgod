# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ArtGod is a cross-platform desktop application for Ethereum NFT trading and indexing. The project is in early development phase with only backend scaffolding currently present.

**Important**: ArtGod is designed as strictly local-focused, peer-to-peer software with no centralized server infrastructure. All processes run locally on the user's machine.

## Architecture

The application follows a multi-component architecture:

1. **Tauri** - Cross-platform distribution layer that packages all components into a desktop app binary
2. **Node.js Backend** - API server, event streaming via SSE, and worker process management
3. **Svelte Frontend** - Web UI served by backend and opened in native browser at localhost:427906
4. **pglite** - Local database for migrations, user settings, contracts/projects data, and worker jobs

### Key Components

- **Backend API** (`backend/`): Node.js server with TypeScript, serves frontend and provides data APIs
- **Indexer Worker**: Planned integration with Ponder for blockchain data processing
- **Configuration**: Native OS window for immediate access to app settings
- **Future Trading Worker**: Integration with NFT marketplaces (Seaport OS, Blur, Payment Processor)

## Development Setup

### Development Commands
```bash
# Install all workspace dependencies
yarn install

# Start all components in development mode
yarn dev

# Build all components for production
yarn build

# Individual component development
cd backend && yarn dev    # API server
cd frontend && yarn dev   # Svelte app  
cd indexer && yarn dev    # Ponder indexer
```

### Technology Stack
- TypeScript with ES2022 target and Node.js modules
- Yarn package manager
- pglite for local database
- Ponder for blockchain indexing (planned)
- Tauri for desktop distribution (planned)

## Project Structure

```
ArtGod/
├── src-tauri/                    # Tauri Rust application (to be initialized)
├── backend/                      # Node.js API server
│   ├── src/                      # TypeScript source (compiles to ./build)
│   ├── package.json
│   └── tsconfig.json
├── frontend/                     # Svelte web application  
│   ├── src/{lib,routes,stores}/
│   └── package.json
├── indexer/                      # Ponder blockchain indexer
│   ├── src/handlers/             # Event handlers per project
│   └── package.json
├── shared/                       # Shared TypeScript types/utilities
│   ├── types/
│   └── utils/
├── database/                     # Database setup and pre-indexed data
│   ├── migrations/               # Schema definitions
│   ├── seeds/                    # Pre-indexed .db artifacts (committed)
│   └── scripts/                  # Manual backfill and export utilities
├── scripts/                      # Development and build scripts
│   ├── dev.sh                    # Start all components
│   └── build.sh                  # Build for production
├── package.json                  # Root workspace configuration
└── IDEA.md                       # Detailed technical specifications
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

## Development Notes

- Project is early-stage with backend scaffolding only
- No source code exists yet in backend/src/
- Frontend (Svelte) and desktop app (Tauri) components not yet implemented
- Core focus is on Ethereum NFT data indexing and trading automation

## Pre-indexing Strategy

**Manual Process** (not automated in CI/CD):
1. Developer runs: `yarn workspace database backfill --contract=terraforms`
2. Export data: `yarn workspace database export --contract=terraforms`
3. Commit seed files: `database/seeds/*.db` stored in git
4. Build process: Seed data bundled into app distribution
5. App startup: Restores from seed data, then syncs incrementally

This avoids slow blockchain indexing in build pipelines while ensuring users get immediate access to historical data.

## Architecture Constraints

- **No centralized servers**: All functionality must be self-contained within the desktop application
- **Local-only operation**: Backend API, workers, and database run entirely on user's machine
- **P2P design**: Any network communication should be direct peer-to-peer or with public blockchain/marketplace APIs
- **Offline capability**: Core functionality should work without internet connectivity where possible
- **Distribution**: Updates and data sharing must work without proprietary server infrastructure
