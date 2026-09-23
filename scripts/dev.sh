#!/bin/bash
set -euo pipefail

echo "🚀 Starting ArtGod development environment..."

# Ensure generated SvelteKit files exist after clean builds.
yarn workspace @artgod/frontend run prepare

# Match desktop startup ordering: market-data recovery finishes before writers.
# Existing services must be stopped before starting a new dev composition.
yarn storage:recover

# Start all services in parallel using workspace commands for PnP compatibility
exec yarn concurrently \
  --kill-others-on-fail \
  --names "backend,indexer,frontend" \
  --prefix-colors "blue,green,yellow" \
  "./scripts/backend-dev.sh" \
  "yarn workspace @artgod/indexer run dev" \
  "./scripts/frontend-dev.sh"
