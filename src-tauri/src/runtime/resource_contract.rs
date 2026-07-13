//! Fixed layout for executable resources bundled with the desktop application.
#![allow(dead_code)]

/// Runtime resource path used by both Tauri source staging and copied build output.
pub(crate) const BUNDLED_RUNTIME_RELATIVE_PATH: &str = "resources/runtime";

/// Generated Rust source that embeds release runtime file hashes.
pub(crate) const GENERATED_WALLET_RECIPIENT_INTEGRITY_FILE_NAME: &str =
    "wallet_recipient_integrity.rs";

/// Build-time snapshot used to prove final bundle bytes match the embedded authority.
pub(crate) const WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_FILE_NAME: &str =
    ".artgod-wallet-recipient-integrity.json";

/// Schema version for the build-time wallet-recipient integrity snapshot.
pub(crate) const WALLET_RECIPIENT_INTEGRITY_SNAPSHOT_VERSION: u64 = 1;

/// Resource subdirectory bundled by Tauri for local runtime artifacts.
pub(crate) const BUNDLED_RUNTIME_DIR_NAME: &str = "runtime";

/// Directory name Tauri preserves when bundling `src-tauri/resources`.
pub(crate) const TAURI_BUNDLED_RESOURCES_DIR_NAME: &str = "resources";

/// macOS bundle resources directory relative to the executable directory.
pub(crate) const MACOS_BUNDLE_RESOURCES_DIR_NAME: &str = "Resources";

/// Linux shared-data directory below the installation prefix.
pub(crate) const LINUX_SHARED_DATA_DIR_NAME: &str = "share";

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

/// Bundled Node distribution directory.
pub(crate) const NODE_RUNTIME_RELATIVE_PATH: &str = "node";

/// Bundled wallet-bound trading runtime directory.
pub(crate) const TRADING_RUNTIME_RELATIVE_PATH: &str = "trading";

/// Complete code/dependency roots that can execute inside a key-bearing bot process.
pub(crate) const WALLET_RECIPIENT_PROTECTED_ROOTS: &[&str] =
    &[NODE_RUNTIME_RELATIVE_PATH, TRADING_RUNTIME_RELATIVE_PATH];
