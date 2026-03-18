#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/app"

if [ "$#" -ne 1 ]; then
    echo "Usage: ./scripts/deploy/run-node-runtime.sh <artifact-relative-path>" >&2
    exit 1
fi

ARTIFACT_PATH="$1"
ABS_ARTIFACT_PATH="$ROOT_DIR/$ARTIFACT_PATH"

if [ ! -f "$ABS_ARTIFACT_PATH" ]; then
    echo "Runtime artifact missing: $ABS_ARTIFACT_PATH" >&2
    exit 1
fi

cd "$ROOT_DIR"

exec node \
    --require "$ROOT_DIR/.pnp.cjs" \
    --experimental-loader "$ROOT_DIR/.pnp.loader.mjs" \
    "$ABS_ARTIFACT_PATH"
