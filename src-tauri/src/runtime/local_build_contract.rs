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
    let resources = &override_config["bundle"]["resources"];
    // Focused debug unit tests explicitly omit packaging inputs.
    if std::env::var("PROFILE").as_deref() != Ok("release") && resources == &serde_json::json!([]) {
        return Ok(());
    }
    let linux_files = &override_config["bundle"]["linux"];
    let has_local_linux_resources = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
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
    let runtime_dir =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?)
            .join(LOCAL_RUNTIME_RELATIVE_PATH);
    validate_runtime_profiles(&runtime_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_runtime_refuses_missing_or_production_artifacts() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate_runtime_profiles(root.path()).is_err());
        for runtime in ["backend", "indexer", "trading"] {
            let directory = root.path().join(runtime).join("dist-desktop");
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join(LOCAL_PROFILE_MARKER_NAME),
                serde_json::json!({"version": 1, "profile": LOCAL_DESKTOP_FEATURE}).to_string(),
            )
            .unwrap();
        }
        validate_runtime_profiles(root.path()).unwrap();
        std::fs::write(
            root.path()
                .join("indexer/dist-desktop")
                .join(LOCAL_PROFILE_MARKER_NAME),
            serde_json::json!({"version": 1, "profile": "desktop"}).to_string(),
        )
        .unwrap();
        assert!(
            validate_runtime_profiles(root.path())
                .unwrap_err()
                .contains("indexer")
        );
    }
}
