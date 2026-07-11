#[path = "src/runtime/resource_contract.rs"]
mod resource_contract;
#[path = "build/runtime_integrity.rs"]
mod runtime_integrity;

fn main() {
    runtime_integrity::generate_wallet_recipient_integrity_manifest()
        .expect("failed to generate wallet recipient runtime integrity manifest");
    tauri_build::build()
}
