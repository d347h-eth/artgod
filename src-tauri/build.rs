use std::env;
use std::path::{Path, PathBuf};

#[path = "src/runtime/resource_contract.rs"]
mod resource_contract;
#[path = "build/runtime_integrity.rs"]
mod runtime_integrity;
#[path = "build/tauri_runtime_output.rs"]
mod tauri_runtime_output;

const CARGO_OUTPUT_DIR_ENV_KEY: &str = "OUT_DIR";
const CARGO_MANIFEST_DIR_ENV_KEY: &str = "CARGO_MANIFEST_DIR";
const CARGO_TARGET_OS_ENV_KEY: &str = "CARGO_CFG_TARGET_OS";
const LINUX_TARGET_OS: &str = "linux";

fn main() {
    let cargo_output_dir =
        PathBuf::from(env::var(CARGO_OUTPUT_DIR_ENV_KEY).expect("Cargo OUT_DIR is unavailable"));
    let profile_output_dir = tauri_runtime_output::profile_output_dir(&cargo_output_dir)
        .expect("Cargo profile output directory is unavailable");

    // Embed the exact trusted source set before Tauri copies runtime resources.
    runtime_integrity::generate_wallet_recipient_integrity_manifest(
        &cargo_output_dir,
        profile_output_dir,
    )
    .expect("failed to generate wallet recipient runtime integrity manifest");

    // Remove only Tauri's prior runtime copy so obsolete chunks cannot survive rebuilds.
    tauri_runtime_output::reconcile_tauri_runtime_output(
        &cargo_output_dir,
        Path::new(resource_contract::BUNDLED_RUNTIME_RELATIVE_PATH),
    )
    .expect("failed to reconcile copied Tauri runtime output");

    tauri_build::build();

    if env::var(CARGO_TARGET_OS_ENV_KEY).as_deref() == Ok(LINUX_TARGET_OS) {
        let manifest_dir = PathBuf::from(
            env::var(CARGO_MANIFEST_DIR_ENV_KEY).expect("Cargo manifest directory is unavailable"),
        );
        let staged_runtime_dir =
            manifest_dir.join(resource_contract::BUNDLED_RUNTIME_RELATIVE_PATH);

        // Linux bundles relocate the runtime, so preserve the adjacent no-bundle layout explicitly.
        tauri_runtime_output::copy_staged_runtime_to_tauri_output(
            &cargo_output_dir,
            &staged_runtime_dir,
            Path::new(resource_contract::BUNDLED_RUNTIME_RELATIVE_PATH),
        )
        .expect("failed to copy staged runtime beside the Linux executable");
    }
}
