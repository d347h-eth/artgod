#!/bin/bash

# ArtGod Development Script
# Starts all components in development mode

echo "🚀 Starting ArtGod development environment..."

# Function to cleanup background processes
cleanup() {
    echo "🛑 Shutting down development environment..."
    jobs -p | xargs -r kill
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start backend API server
echo "📡 Starting backend API server..."
cd backend && yarn dev &
BACKEND_PID=$!

# Wait for backend to be ready
sleep 3

# Start indexer worker
echo "🔍 Starting blockchain indexer..."
cd ../indexer && yarn dev &
INDEXER_PID=$!

# Start frontend development server
echo "🎨 Starting frontend development server..."
cd ../frontend && yarn dev &
FRONTEND_PID=$!

echo "✅ All services started!"
echo "📱 Frontend: http://localhost:5173"
echo "🔌 Backend API: http://localhost:3000"
echo "📊 Indexer: http://localhost:42069"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for all background processes
wait