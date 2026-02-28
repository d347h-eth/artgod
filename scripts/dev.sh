#!/bin/bash

echo "🚀 Starting ArtGod development environment..."

# Ensure generated SvelteKit files exist after clean builds.
yarn workspace @artgod/frontend run prepare

# Start all services in parallel using workspace commands for PnP compatibility
exec yarn concurrently \
  --kill-others-on-fail \
  --names "backend,indexer,frontend" \
  --prefix-colors "blue,green,yellow" \
  "yarn workspace @artgod/backend run dev" \
  "yarn workspace @artgod/indexer run dev" \
  "yarn workspace @artgod/frontend run dev"
