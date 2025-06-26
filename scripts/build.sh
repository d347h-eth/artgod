#!/bin/bash

# ArtGod Production Build Script
# Builds all components for production distribution

echo "🏗️  Building ArtGod for production..."

# Exit on any error
set -e

# Build shared types first
echo "📦 Building shared types..."
cd shared && yarn build

# Build backend
echo "🔧 Building backend..."
cd ../backend && yarn build

# Build indexer
echo "🔍 Building indexer..."
cd ../indexer && yarn build

# Build frontend
echo "🎨 Building frontend..."
cd ../frontend && yarn build

# Package pre-indexed data artifacts
echo "💾 Packaging pre-indexed data..."
mkdir -p ../dist/database
cp database/seeds/*.db ../dist/database/ 2>/dev/null || echo "No seed data found - app will start with empty database"

echo "✅ All components built successfully!"
echo "🚀 Ready for Tauri bundling: cargo tauri build"