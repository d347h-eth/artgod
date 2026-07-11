//! Fixed layout for executable resources bundled with the desktop application.

/// Resource subdirectory bundled by Tauri for local runtime artifacts.
pub(crate) const BUNDLED_RUNTIME_DIR_NAME: &str = "runtime";

/// Directory name Tauri preserves when bundling `src-tauri/resources`.
pub(crate) const TAURI_BUNDLED_RESOURCES_DIR_NAME: &str = "resources";

/// macOS bundle resources directory relative to the executable directory.
pub(crate) const MACOS_BUNDLE_RESOURCES_DIR_NAME: &str = "Resources";

/// Bundled Node executable used by every desktop Node runtime.
#[cfg(windows)]
pub(crate) const NODE_BINARY_RELATIVE_PATH: &str = "node/node.exe";

/// Bundled Node executable used by every desktop Node runtime.
#[cfg(not(windows))]
pub(crate) const NODE_BINARY_RELATIVE_PATH: &str = "node/node";

/// Bundled NATS executable used by the desktop core composition.
#[cfg(windows)]
pub(crate) const NATS_BINARY_RELATIVE_PATH: &str = "nats/nats-server.exe";

/// Bundled NATS executable used by the desktop core composition.
#[cfg(not(windows))]
pub(crate) const NATS_BINARY_RELATIVE_PATH: &str = "nats/nats-server";

/// Bundled Yarn PnP CommonJS hook used by desktop Node runtimes.
pub(crate) const PNP_CJS_RELATIVE_PATH: &str = ".pnp.cjs";

/// Bundled Yarn PnP ESM loader used by desktop Node runtimes.
pub(crate) const PNP_LOADER_RELATIVE_PATH: &str = ".pnp.loader.mjs";
