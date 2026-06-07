use std::collections::{HashMap, HashSet};

use serde::Deserialize;

const SETTINGS_MANIFEST_VERSION: u8 = 1;
const SETTINGS_MANIFEST: &str = include_str!("../../../config/settings.manifest.toml");
const SUPPORTED_VALIDATION_RULES: &[&str] = &[
    "url",
    "positive_integer",
    "rpc_endpoint_list",
    "websocket_endpoint_list",
];
const SUPPORTED_TARGETS: &[&str] = &["local", "deploy", "desktop"];

/// Validated Admin configuration schema embedded into the desktop binary.
pub struct AppConfigManifestModel {
    pub groups: Vec<AppConfigManifestGroup>,
    pub settings: Vec<AppConfigManifestSetting>,
    pub ordered_keys: Vec<String>,
    pub defaults: HashMap<String, String>,
}

/// Display group for Admin configuration fields and rendered env comments.
#[derive(Clone)]
pub struct AppConfigManifestGroup {
    pub id: String,
    pub label: String,
}

/// Admin schema metadata for one runtime env setting.
#[derive(Clone)]
pub struct AppConfigManifestSetting {
    pub key: String,
    pub group: String,
    pub label: String,
    pub input: String,
    pub secret: bool,
    pub options: Vec<String>,
    pub help: String,
    pub required_for_launch: bool,
    pub validation: Option<String>,
    pub view: Option<String>,
}

#[derive(Deserialize)]
struct ManifestDocument {
    version: u8,
    groups: Vec<ManifestGroupDocument>,
    settings: Vec<ManifestSettingDocument>,
}

#[derive(Deserialize)]
struct ManifestGroupDocument {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct ManifestSettingDocument {
    key: String,
    group: String,
    label: String,
    default: Option<String>,
    #[serde(default)]
    defaults: ManifestSettingDefaultsDocument,
    desktop_default: Option<String>,
    targets: Option<Vec<String>>,
    input: Option<String>,
    #[serde(default)]
    secret: bool,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    help: String,
    #[serde(default)]
    required_for_launch: bool,
    #[serde(default = "default_true")]
    desktop_managed: bool,
    validation: Option<String>,
    view: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ManifestSettingDefaultsDocument {
    local: Option<String>,
    deploy: Option<String>,
    desktop: Option<String>,
}

/// Loads and validates the embedded settings manifest used by Admin config.
pub fn load_app_config_manifest() -> Result<AppConfigManifestModel, String> {
    let document: ManifestDocument = toml::from_str(SETTINGS_MANIFEST)
        .map_err(|error| format!("Failed to parse settings manifest: {error}"))?;
    build_manifest_model(document)
}

fn build_manifest_model(document: ManifestDocument) -> Result<AppConfigManifestModel, String> {
    if document.version != SETTINGS_MANIFEST_VERSION {
        return Err(format!(
            "Unsupported settings manifest version {}",
            document.version
        ));
    }

    let mut errors = Vec::<String>::new();
    let mut group_ids = HashSet::<String>::new();
    let mut groups = Vec::<AppConfigManifestGroup>::new();
    for group in document.groups {
        if group.id.trim().is_empty() {
            errors.push("settings manifest group id cannot be empty".to_owned());
        }
        if group.label.trim().is_empty() {
            errors.push(format!(
                "settings manifest group {} label cannot be empty",
                group.id
            ));
        }
        if !group_ids.insert(group.id.clone()) {
            errors.push(format!("duplicate settings manifest group {}", group.id));
        }
        groups.push(AppConfigManifestGroup {
            id: group.id,
            label: group.label,
        });
    }

    let mut setting_keys = HashSet::<String>::new();
    let mut ordered_keys = Vec::<String>::new();
    let mut defaults = HashMap::<String, String>::new();
    let mut settings = Vec::<AppConfigManifestSetting>::new();
    let mut desktop_group_ids = HashSet::<String>::new();
    for setting in document.settings {
        if setting.key.trim().is_empty() {
            errors.push("settings manifest key cannot be empty".to_owned());
        }
        if setting.label.trim().is_empty() {
            errors.push(format!(
                "settings manifest setting {} label cannot be empty",
                setting.key
            ));
        }
        if !group_ids.contains(&setting.group) {
            errors.push(format!(
                "settings manifest setting {} references unknown group {}",
                setting.key, setting.group
            ));
        }
        if !setting_keys.insert(setting.key.clone()) {
            errors.push(format!(
                "duplicate settings manifest setting {}",
                setting.key
            ));
        }

        let input = setting.input.clone().unwrap_or_else(|| "text".to_owned());
        if !matches!(
            input.as_str(),
            "text" | "password" | "checkbox" | "textarea" | "select" | "weighted_endpoint_list"
        ) {
            errors.push(format!(
                "settings manifest setting {} uses unsupported input {}",
                setting.key, input
            ));
        }
        if input == "select" && setting.options.is_empty() {
            errors.push(format!(
                "settings manifest setting {} select input requires options",
                setting.key
            ));
        }
        if input != "select" && !setting.options.is_empty() {
            errors.push(format!(
                "settings manifest setting {} has options but is not a select",
                setting.key
            ));
        }
        if let Some(view) = setting.view.as_deref()
            && !matches!(view, "basic" | "advanced")
        {
            errors.push(format!(
                "settings manifest setting {} uses unsupported view {}",
                setting.key, view
            ));
        }
        if let Some(validation) = setting.validation.as_deref()
            && !SUPPORTED_VALIDATION_RULES.contains(&validation)
        {
            errors.push(format!(
                "settings manifest setting {} uses unsupported validation {}",
                setting.key, validation
            ));
        }
        if let Some(targets) = setting.targets.as_ref() {
            for target in targets {
                if !SUPPORTED_TARGETS.contains(&target.as_str()) {
                    errors.push(format!(
                        "settings manifest setting {} uses unsupported target {}",
                        setting.key, target
                    ));
                }
            }
        }
        for target in setting_targets(&setting) {
            if resolve_default_for_target(&setting, target).is_none() {
                errors.push(format!(
                    "settings manifest setting {} is missing default for target {}",
                    setting.key, target
                ));
            }
        }

        if setting.desktop_managed && has_target(&setting, "desktop") {
            let default_value = resolve_default_for_target(&setting, "desktop").unwrap_or_default();
            desktop_group_ids.insert(setting.group.clone());
            ordered_keys.push(setting.key.clone());
            defaults.insert(setting.key.clone(), default_value);
            settings.push(AppConfigManifestSetting {
                key: setting.key,
                group: setting.group,
                label: setting.label,
                input,
                secret: setting.secret,
                options: setting.options,
                help: setting.help,
                required_for_launch: setting.required_for_launch,
                validation: setting.validation,
                view: setting.view,
            });
        }
    }

    if !errors.is_empty() {
        return Err(format!(
            "Invalid settings manifest:\n- {}",
            errors.join("\n- ")
        ));
    }

    Ok(AppConfigManifestModel {
        groups: groups
            .into_iter()
            .filter(|group| desktop_group_ids.contains(&group.id))
            .collect(),
        settings,
        ordered_keys,
        defaults,
    })
}

fn default_true() -> bool {
    true
}

fn setting_targets(setting: &ManifestSettingDocument) -> Vec<&str> {
    match setting.targets.as_ref() {
        Some(targets) => targets.iter().map(String::as_str).collect(),
        None => SUPPORTED_TARGETS.to_vec(),
    }
}

fn has_target(setting: &ManifestSettingDocument, expected: &str) -> bool {
    setting_targets(setting)
        .into_iter()
        .any(|target| target == expected)
}

fn resolve_default_for_target(setting: &ManifestSettingDocument, target: &str) -> Option<String> {
    match target {
        "local" => setting.defaults.local.clone(),
        "deploy" => setting.defaults.deploy.clone(),
        "desktop" => setting
            .defaults
            .desktop
            .clone()
            .or_else(|| setting.desktop_default.clone()),
        _ => None,
    }
    .or_else(|| setting.default.clone())
    .or_else(|| setting.defaults.local.clone())
}

#[cfg(test)]
mod tests {
    use super::super::env_keys::{RPC_ENDPOINT_LIST_ENV_KEY, RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY};
    use super::*;

    #[test]
    fn manifest_defaults_use_desktop_overrides() {
        let model = load_app_config_manifest().expect("load settings manifest");

        assert_eq!(
            model.defaults.get("ARTGOD_DB_PATH"),
            Some(&"sqlite/main/db".to_owned())
        );
        assert_eq!(
            model.defaults.get("BACKEND_PORT"),
            Some(&"42710".to_owned())
        );
    }

    #[test]
    fn manifest_contains_unique_setting_keys() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let keys = model.ordered_keys.iter().collect::<HashSet<_>>();

        assert_eq!(keys.len(), model.ordered_keys.len());
        assert_eq!(model.settings.len(), model.ordered_keys.len());
    }

    #[test]
    fn public_deployment_settings_are_not_admin_managed() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let public_keys = [
            "PUBLIC_BACKEND_ORIGIN",
            "INTERNAL_BACKEND_ORIGIN",
            "PUBLIC_APP_DEPLOYMENT_MODE",
            "PUBLIC_APP_CHAIN_REF",
            "PUBLIC_APP_COLLECTION_REF",
        ];

        for key in public_keys {
            assert!(!model.ordered_keys.iter().any(|entry| entry == key));
            assert!(!model.defaults.contains_key(key));
            assert!(!model.settings.iter().any(|setting| setting.key == key));
        }
        assert!(
            !model
                .groups
                .iter()
                .any(|group| group.id == "public-deployment")
        );
    }

    #[test]
    fn manifest_marks_rpc_url_list_required_for_launch() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let setting = model
            .settings
            .iter()
            .find(|setting| setting.key == RPC_ENDPOINT_LIST_ENV_KEY)
            .expect("RPC_URL_LIST setting should exist");

        assert!(setting.required_for_launch);
        assert_eq!(setting.input, "weighted_endpoint_list");
        assert_eq!(setting.validation.as_deref(), Some("rpc_endpoint_list"));
    }

    #[test]
    fn manifest_marks_rpc_ws_url_list_optional_websocket_endpoint_list() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let setting = model
            .settings
            .iter()
            .find(|setting| setting.key == RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY)
            .expect("RPC_WS_URL_LIST setting");

        assert!(!setting.required_for_launch);
        assert_eq!(setting.input, "weighted_endpoint_list");
        assert_eq!(
            setting.validation.as_deref(),
            Some("websocket_endpoint_list")
        );
    }

    #[test]
    fn manifest_marks_desktop_log_retention_positive_integer() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let setting = model
            .settings
            .iter()
            .find(|setting| setting.key == "DESKTOP_LOG_RETENTION_HOURS")
            .expect("DESKTOP_LOG_RETENTION_HOURS setting");

        assert_eq!(
            model
                .defaults
                .get("DESKTOP_LOG_RETENTION_HOURS")
                .map(String::as_str),
            Some("48")
        );
        assert_eq!(setting.validation.as_deref(), Some("positive_integer"));
    }
}
