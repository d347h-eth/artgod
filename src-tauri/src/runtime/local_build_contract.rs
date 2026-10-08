//! Identity and resource location of the opt-in local desktop build.
//! The local JavaScript build tools read these constants as their native contract.
#![allow(dead_code)]

pub const LOCAL_DESKTOP_FEATURE: &str = "desktop-local-observability";
pub const LOCAL_RUNTIME_RELATIVE_PATH: &str = "resources/runtime-local";
pub const LOCAL_LINUX_APPIMAGE_RUNTIME_PATH: &str = "/usr/share/ArtGod/resources/runtime-local";
pub const LOCAL_LINUX_DEB_RUNTIME_PATH: &str = "/usr/lib/ArtGod/resources/runtime-local";

pub const LOCAL_PROFILE_MARKER_NAME: &str = ".artgod-runtime-build-profile.json";

/// Rejects mixed local/production resources both before compilation and at startup.
pub fn validate_runtime_profiles(runtime_dir: &std::path::Path) -> Result<(), String> {
    for runtime in ["backend", "indexer", "trading"] {
        let marker_path = runtime_dir
            .join(runtime)
            .join("dist-desktop")
            .join(LOCAL_PROFILE_MARKER_NAME);
        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&marker_path).map_err(|error| {
                format!(
                    "Local desktop profile missing at {}: {error}",
                    marker_path.display()
                )
            })?)
            .map_err(|error| format!("Invalid local desktop profile: {error}"))?;
        if marker["version"] != 1 || marker["profile"] != LOCAL_DESKTOP_FEATURE {
            return Err(format!(
                "Local desktop requires {LOCAL_DESKTOP_FEATURE} artifacts for {runtime}"
            ));
        }
    }
    Ok(())
}

/// Tauri's feature and resource overlay must be selected together by the local entry point.
pub fn validate_build_inputs() -> Result<(), String> {
    let override_config: serde_json::Value =
        serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_default()).map_err(|_| {
            "Use yarn build:desktop:local to select local desktop resources".to_owned()
        })?;
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").map_err(|e| e.to_string())?;
    let runtime_dir =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?)
            .join(LOCAL_RUNTIME_RELATIVE_PATH);
    validate_selected_build_inputs(&override_config, &target_os, &runtime_dir)
}

// Keep the same resource/profile checks for debug, release and native tests.
// Explicit inputs let unit tests exercise the real guard without process-env races.
fn validate_selected_build_inputs(
    override_config: &serde_json::Value,
    target_os: &str,
    runtime_dir: &std::path::Path,
) -> Result<(), String> {
    let resources = &override_config["bundle"]["resources"];
    let linux_files = &override_config["bundle"]["linux"];
    let has_local_linux_resources = target_os == "linux"
        && resources == &serde_json::json!([])
        && linux_files["appimage"]["files"][LOCAL_LINUX_APPIMAGE_RUNTIME_PATH]
            == LOCAL_RUNTIME_RELATIVE_PATH
        && linux_files["deb"]["files"][LOCAL_LINUX_DEB_RUNTIME_PATH] == LOCAL_RUNTIME_RELATIVE_PATH;
    if resources != &serde_json::json!([LOCAL_RUNTIME_RELATIVE_PATH]) && !has_local_linux_resources
    {
        return Err(
            "Local desktop Cargo feature and Tauri resource selection do not match".to_owned(),
        );
    }
    validate_runtime_profiles(runtime_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux_overlay() -> serde_json::Value {
        serde_json::json!({
            "bundle": {
                "resources": [],
                "linux": {
                    "appimage": {"files": {LOCAL_LINUX_APPIMAGE_RUNTIME_PATH: LOCAL_RUNTIME_RELATIVE_PATH}},
                    "deb": {"files": {LOCAL_LINUX_DEB_RUNTIME_PATH: LOCAL_RUNTIME_RELATIVE_PATH}}
                }
            }
        })
    }

    fn write_profiles(root: &std::path::Path, indexer_profile: &str) {
        for runtime in ["backend", "indexer", "trading"] {
            let directory = root.join(runtime).join("dist-desktop");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join(LOCAL_PROFILE_MARKER_NAME),
                serde_json::json!({
                    "version": 1,
                    "profile": if runtime == "indexer" { indexer_profile } else { LOCAL_DESKTOP_FEATURE }
                }).to_string(),
            ).unwrap();
        }
    }

    #[test]
    fn linux_build_inputs_require_local_profiles_with_empty_bundle_resources() {
        let root = tempfile::tempdir().unwrap();
        let overlay = linux_overlay();
        assert!(validate_selected_build_inputs(&overlay, "linux", root.path()).is_err());

        write_profiles(root.path(), "desktop");
        assert!(
            validate_selected_build_inputs(&overlay, "linux", root.path())
                .unwrap_err()
                .contains("indexer")
        );

        write_profiles(root.path(), LOCAL_DESKTOP_FEATURE);
        validate_selected_build_inputs(&overlay, "linux", root.path()).unwrap();
    }

    #[test]
    fn build_inputs_reject_empty_or_incomplete_linux_resource_pairing() {
        let root = tempfile::tempdir().unwrap();
        write_profiles(root.path(), LOCAL_DESKTOP_FEATURE);
        let mut incomplete = linux_overlay();
        incomplete["bundle"]["linux"]["deb"]["files"] = serde_json::json!({});
        for overlay in [serde_json::json!({"bundle": {"resources": []}}), incomplete] {
            assert!(
                validate_selected_build_inputs(&overlay, "linux", root.path())
                    .unwrap_err()
                    .contains("resource selection do not match")
            );
        }
    }

    #[test]
    fn non_linux_build_inputs_require_the_local_resource_tree() {
        let root = tempfile::tempdir().unwrap();
        write_profiles(root.path(), LOCAL_DESKTOP_FEATURE);
        let overlay = serde_json::json!({"bundle": {"resources": [LOCAL_RUNTIME_RELATIVE_PATH]}});
        for target_os in ["macos", "windows"] {
            validate_selected_build_inputs(&overlay, target_os, root.path()).unwrap();
            assert!(
                validate_selected_build_inputs(&linux_overlay(), target_os, root.path()).is_err()
            );
        }
    }

    #[test]
    fn local_runtime_refuses_missing_or_production_artifacts() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate_runtime_profiles(root.path()).is_err());
        write_profiles(root.path(), LOCAL_DESKTOP_FEATURE);
        validate_runtime_profiles(root.path()).unwrap();
        write_profiles(root.path(), "desktop");
        assert!(
            validate_runtime_profiles(root.path())
                .unwrap_err()
                .contains("indexer")
        );
    }
}
