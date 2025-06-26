#!/bin/bash

echo "🚀 Starting ArtGod development environment..."

# Start all services in parallel, using exec to replace the process
exec yarn concurrently \
  --names "backend,indexer,frontend" \
  --prefix-colors "blue,green,yellow" \
  "cd backend && yarn dev" \
  "cd indexer && yarn dev" \
  "cd frontend && yarn dev"