#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
git_common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
node_version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).engines.node' "$repo_root/package.json")"
rust_toolchain="$(sed -n 's/[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$repo_root/rust-toolchain.toml" | head -n 1)"

if [ -z "$node_version" ]; then
    echo "Unable to read engines.node from package.json" >&2
    exit 1
fi

if [ -z "$rust_toolchain" ]; then
    echo "Unable to read channel from rust-toolchain.toml" >&2
    exit 1
fi

# Use the same reviewed archive owner as desktop staging before container bootstrap.
node_archive_path="$(node "$script_dir/desktop-runtime-inputs.mjs" --node-archive linux-x64)"

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
    --volume "$git_common_dir":"$git_common_dir":ro \
    --volume "$node_archive_path":/artgod-build-inputs/node.tar.xz:ro \
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
        frontend/.svelte-kit \
        frontend/dist \
        frontend/dist-userland \
        backend/dist-desktop \
        indexer/dist-desktop \
        trading/dist-desktop \
        src-tauri/binaries \
        src-tauri/resources/runtime \
        src-tauri/target \
        node-v*.tar.xz
    do
        [ -e "$path" ] || continue
        chown -R "$ARTGOD_HOST_UID:$ARTGOD_HOST_GID" "$path"
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
    squashfs-tools \
    file \
    xdg-utils \
    python3 \
    make \
    g++ \
    xz-utils \
    passwd \
    util-linux

tar -xJf /artgod-build-inputs/node.tar.xz -C /opt
export PATH="/opt/node-v${ARTGOD_NODE_VERSION}-linux-x64/bin:${PATH}"
corepack enable

# Compile as the host repository owner, just as CI compiles as its checkout
# owner. Keep Git safety checks active and avoid root-owned build artifacts.
if ! getent group "$ARTGOD_HOST_GID" >/dev/null; then
    groupadd --gid "$ARTGOD_HOST_GID" runner
fi
if ! getent passwd "$ARTGOD_HOST_UID" >/dev/null; then
    useradd --uid "$ARTGOD_HOST_UID" --gid "$ARTGOD_HOST_GID" \
        --create-home --home-dir /home/runner --shell /bin/bash runner
fi
build_user="$(getent passwd "$ARTGOD_HOST_UID" | cut -d: -f1)"
mkdir -p "$CARGO_HOME"
chown "$ARTGOD_HOST_UID:$ARTGOD_HOST_GID" /home/runner "$CARGO_HOME"

# Normalize only generated files for this lane from earlier root-based runs.
# Apply the same ownership contract before compilation and on exit.
restore_ownership

runuser --user "$build_user" -- bash <<"ARTGOD_BUILD"
set -euo pipefail

git rev-parse --verify HEAD
mkdir -p "$CARGO_HOME"
curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain "$ARTGOD_RUST_TOOLCHAIN" --profile minimal
. "$CARGO_HOME/env"
rustup target add x86_64-unknown-linux-gnu

yarn install --immutable
yarn build:sqlite-native
yarn check:runtime-registry
yarn test:desktop:listener-boundaries

target_triple="x86_64-unknown-linux-gnu"
# Clear stale AppDir contents from previous failed local repro runs.
rm -rf "src-tauri/target/${target_triple}/release/bundle"
yarn build:desktop:linux-bundle
yarn check:desktop-runtime-resources
yarn check:linux-bundled-runtime "src-tauri/target/${target_triple}/release/bundle"
ARTGOD_BUILD
'
