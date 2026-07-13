#[path = "../src/runtime/resource_contract.rs"]
mod resource_contract;

use resource_contract::BUNDLED_RUNTIME_RELATIVE_PATH;
use serde_json::Value;

#[test]
fn linux_bundles_relocate_runtime_while_other_platforms_keep_standard_resources() {
    let base: Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("parse base Tauri config");
    let linux: Value = serde_json::from_str(include_str!("../tauri.linux.conf.json"))
        .expect("parse Linux Tauri config");
    let product_name = base["productName"]
        .as_str()
        .expect("base config product name");
    let base_resources = base["bundle"]["resources"]
        .as_array()
        .expect("base bundled resources");
    let linux_resources = linux["bundle"]["resources"]
        .as_array()
        .expect("Linux bundled resources override");
    let appimage_destination = format!("/usr/share/{product_name}/{BUNDLED_RUNTIME_RELATIVE_PATH}");
    let deb_destination = format!("/usr/lib/{product_name}/{BUNDLED_RUNTIME_RELATIVE_PATH}");

    assert!(
        base_resources
            .iter()
            .any(|resource| resource == BUNDLED_RUNTIME_RELATIVE_PATH)
    );
    assert!(linux_resources.is_empty());
    assert_eq!(
        linux["bundle"]["linux"]["appimage"]["files"][&appimage_destination],
        BUNDLED_RUNTIME_RELATIVE_PATH
    );
    assert_eq!(
        linux["bundle"]["linux"]["deb"]["files"][&deb_destination],
        BUNDLED_RUNTIME_RELATIVE_PATH
    );
}
