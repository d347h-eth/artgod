# Database & Pre-indexing

This directory contains database schema, migrations, and pre-indexed blockchain data.

## Pre-indexing Workflow

### 1. Manual Data Collection
```bash
# Run full backfill (can take hours)
yarn workspace database backfill --contract=terraforms

# Export to seed file
yarn workspace database export --contract=terraforms --output=seeds/terraforms.db
```

### 2. Committing Seed Data
- Pre-indexed `.db` files are stored in `seeds/` directory
- Commit these artifacts to git (consider Git LFS for large files)
- Files are bundled into app distribution during build

### 3. App Startup
- App checks for existing local database
- If missing/outdated, restores from bundled seed data
- Starts incremental sync from last indexed block

## Directory Structure

```
database/
├── migrations/              # Database schema migrations
├── seeds/                   # Pre-indexed data artifacts
│   ├── terraforms.db       # Exported pglite database
│   ├── terraforms-metadata.json
│   ├── wcsg.db
│   └── angelus.db
└── scripts/
    ├── backfill.ts         # Manual indexing script
    └── export.ts           # Database export utility
```

## Notes

- **Never run indexing in CI/CD** - too slow and resource intensive
- **Manual process** - Developer runs backfill locally, commits results
- **Incremental updates** - App syncs from last known block on startup
- **Fallback strategy** - App works without seed data, just starts empty