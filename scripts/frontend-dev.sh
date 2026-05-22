#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/tmp/logs"
LOG_FILE="$LOG_DIR/frontend-web.log"

mkdir -p "$LOG_DIR"
: > "$LOG_FILE"

echo "Starting frontend web (log: $LOG_FILE)"
exec yarn workspace @artgod/frontend run dev > >(tee -a "$LOG_FILE") 2> >(tee -a "$LOG_FILE" >&2)

