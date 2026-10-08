#!/bin/sh
set -eu

# Exercise Tauri's real Cargo invocation without launching an app against the
# operator's shared settings, database or wallets.
if [ "$1" != "run" ]; then
    echo "Expected Tauri's Cargo run operation." >&2
    exit 1
fi
shift
exec cargo build "$@"
