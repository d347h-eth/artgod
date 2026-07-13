use std::env;
use std::path::{Path, PathBuf};

#[path = "src/runtime/resource_contract.rs"]
mod resource_contract;
#[path = "build/runtime_integrity.rs"]
mod runtime_integrity;
#[path = "build/tauri_runtime_output.rs"]
mod tauri_runtime_output;

const CARGO_OUTPUT_DIR_ENV_KEY: &str = "OUT_DIR";

fn main() {
    let cargo_output_dir =
        PathBuf::from(env::var(CARGO_OUTPUT_DIR_ENV_KEY).expect("Cargo OUT_DIR is unavailable"));

    // Embed the exact trusted source set before Tauri copies runtime resources.
    runtime_integrity::generate_wallet_recipient_integrity_manifest(&cargo_output_dir)
        .expect("failed to generate wallet recipient runtime integrity manifest");

    // Remove only Tauri's prior runtime copy so obsolete chunks cannot survive rebuilds.
    tauri_runtime_output::reconcile_tauri_runtime_output(
        &cargo_output_dir,
        Path::new(resource_contract::BUNDLED_RUNTIME_RELATIVE_PATH),
    )
    .expect("failed to reconcile copied Tauri runtime output");

    tauri_build::build()
}
