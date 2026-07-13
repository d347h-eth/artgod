#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
node_version="$(sed -n 's/.*"node": "\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -n 1)"
rust_toolchain="$(sed -n 's/[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$repo_root/rust-toolchain.toml" | head -n 1)"

if [ -z "$node_version" ]; then
    echo "Unable to read engines.node from package.json" >&2
    exit 1
fi

if [ -z "$rust_toolchain" ]; then
    echo "Unable to read channel from rust-toolchain.toml" >&2
    exit 1
fi

docker run --rm \
    --env ARTGOD_HOST_UID="$(id -u)" \
    --env ARTGOD_HOST_GID="$(id -g)" \
    --env ARTGOD_NODE_VERSION="$node_version" \
    --env ARTGOD_RUST_TOOLCHAIN="$rust_toolchain" \
    --env CARGO_HOME=/home/runner/.cargo \
    --env CARGO_INCREMENTAL=0 \
    --env CARGO_TERM_COLOR=always \
    --env DESKTOP_NODE_DIST_TARGET=linux-x64 \
    --env DESKTOP_NATS_DIST_TARGET=linux-x64 \
    --env APPIMAGE_EXTRACT_AND_RUN=1 \
    --volume "$repo_root":/home/runner/work/artgod/artgod \
    --workdir /home/runner/work/artgod/artgod \
    ubuntu:22.04 \
    bash -lc '
set -euo pipefail

restore_ownership() {
    for path in \
        .cache \
        .pnp.cjs \
        .pnp.loader.mjs \
        .yarn/cache \
        .yarn/install-state.gz \
        .yarn/unplugged \
        src-tauri/binaries \
        src-tauri/resources/runtime \
        src-tauri/target \
        node-v*.tar.xz
    do
        [ -e "$path" ] || continue
        chown -R "$ARTGOD_HOST_UID:$ARTGOD_HOST_GID" "$path" || true
    done
}
trap restore_ownership EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    pkg-config \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libfuse2 \
    libssl-dev \
    libxdo-dev \
    patchelf \
    file \
    xdg-utils \
    python3 \
    make \
    g++ \
    xz-utils

node_archive="node-v${ARTGOD_NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLo "/tmp/${node_archive}" "https://nodejs.org/dist/v${ARTGOD_NODE_VERSION}/${node_archive}"
tar -xJf "/tmp/${node_archive}" -C /opt
export PATH="/opt/node-v${ARTGOD_NODE_VERSION}-linux-x64/bin:${PATH}"

mkdir -p "$CARGO_HOME"
curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain "$ARTGOD_RUST_TOOLCHAIN" --profile minimal
. "$CARGO_HOME/env"
rustup target add x86_64-unknown-linux-gnu

corepack enable
yarn install --immutable
yarn build:sqlite-native
yarn check:runtime-registry
yarn test:desktop:listener-boundaries

target_triple="x86_64-unknown-linux-gnu"
# Clear stale AppDir contents from previous failed local repro runs.
rm -rf "src-tauri/target/${target_triple}/release/bundle"
yarn prepare:tauri-linux-tools
yarn tauri build --ci --target "$target_triple" --bundles appimage,deb
yarn check:desktop-runtime-resources
'
