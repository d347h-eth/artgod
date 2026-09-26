//! Local build eligibility only. The canonical manifest still owns every field.
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde::Deserialize;

use super::{ManifestDocument, has_target, resolve_default_for_target};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LocalObservabilitySettings {
    pub(super) settings: Vec<String>,
    metrics_host_keys: Vec<String>,
}

pub(super) static LOCAL_SETTINGS: LazyLock<LocalObservabilitySettings> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../config/desktop-local-observability.json"
    ))
    .expect("valid local desktop observability selection")
});

/// Adds only the existing exporter controls; ordinary desktop defaults stay intact.
pub(super) fn extend_manifest(mut document: ManifestDocument) -> Result<ManifestDocument, String> {
    let mut seen = HashSet::new();
    for key in &LOCAL_SETTINGS.settings {
        if !seen.insert(key) {
            return Err(format!("Duplicate local observability setting: {key}"));
        }
        let setting = document
            .settings
            .iter_mut()
            .find(|setting| &setting.key == key)
            .ok_or_else(|| format!("Unknown local observability setting: {key}"))?;
        if !setting.desktop_managed
            || !has_target(setting, "local")
            || has_target(setting, "desktop")
        {
            return Err(format!(
                "Local observability setting must extend the desktop schema: {key}"
            ));
        }
        setting.defaults.desktop = Some(
            resolve_default_for_target(setting, "local")
                .ok_or_else(|| format!("Missing local observability default: {key}"))?,
        );
        setting
            .targets
            .as_mut()
            .expect("explicit local targets")
            .push("desktop".to_owned());
    }
    for key in &LOCAL_SETTINGS.metrics_host_keys {
        if seen.contains(key) || !document.settings.iter().any(|setting| &setting.key == key) {
            return Err(format!(
                "Invalid native-owned observability listener: {key}"
            ));
        }
    }
    Ok(document)
}

/// Exporters in the local desktop retain the installed app's loopback boundary.
pub(crate) fn enforce_metrics_loopback(process_env: &mut HashMap<String, String>, host: &str) {
    for key in &LOCAL_SETTINGS.metrics_host_keys {
        process_env.insert(key.clone(), host.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        SETTINGS_MANIFEST, SETTINGS_VALIDATION_RULES, build_manifest_model,
        load_app_config_manifest,
    };
    use super::*;

    #[test]
    fn local_schema_extends_exactly_the_existing_desktop_fields() {
        let rules: HashMap<String, String> =
            serde_json::from_str(SETTINGS_VALIDATION_RULES).unwrap();
        let production = build_manifest_model(
            toml::from_str(SETTINGS_MANIFEST).unwrap(),
            &rules.into_values().collect(),
        )
        .unwrap();
        let local = load_app_config_manifest().unwrap();
        assert_eq!(
            local.settings.len(),
            production.settings.len() + LOCAL_SETTINGS.settings.len()
        );
        for (key, default) in production.defaults {
            assert_eq!(local.defaults.get(&key), Some(&default), "{key}");
        }
        for key in &LOCAL_SETTINGS.settings {
            assert!(local.settings.iter().any(|field| &field.key == key));
        }
        for key in &LOCAL_SETTINGS.metrics_host_keys {
            assert!(!local.defaults.contains_key(key));
        }
        for key in [
            "BACKEND_METRICS_ENABLED",
            "INDEXER_METRICS_ENABLED",
            "BACKEND_APM_ENABLED",
            "INDEXER_APM_ENABLED",
        ] {
            assert_eq!(local.defaults[key], "false");
        }
    }

    #[test]
    fn metrics_hosts_override_saved_or_ambient_values() {
        let mut values = LOCAL_SETTINGS
            .metrics_host_keys
            .iter()
            .map(|key| (key.clone(), "0.0.0.0".to_owned()))
            .collect();
        enforce_metrics_loopback(&mut values, "127.0.0.1");
        assert!(values.values().all(|value| value == "127.0.0.1"));
    }
}
