#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/tmp/logs"

mkdir -p "$LOG_DIR"

pids=()

start_worker() {
    local name="$1"
    local script="$2"
    local log_file="$LOG_DIR/$name.log"

    : > "$log_file"
    echo "Starting $name (log: $log_file)"
    yarn workspace @artgod/indexer run "$script" > "$log_file" 2>&1 &
    pids+=("$!")
}

cleanup() {
    echo "Shutting down indexer workers..."
    for pid in "${pids[@]:-}"; do
        if kill "$pid" 2>/dev/null; then
            :
        fi
    done
    wait || true
}

trap cleanup INT TERM EXIT

start_worker "indexer-scheduler" "dev:scheduler"
start_worker "indexer-sync-worker" "dev:sync-worker"
start_worker "indexer-reorg-worker" "dev:reorg-worker"
start_worker "indexer-domain-worker" "dev:domain-worker"
start_worker "indexer-dead-letter-worker" "dev:dead-letter-worker"

echo "Indexer workers running. Logs: $LOG_DIR"

wait
