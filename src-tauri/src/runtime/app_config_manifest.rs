use std::collections::{HashMap, HashSet};

use serde::Deserialize;

const SETTINGS_MANIFEST_VERSION: u8 = 1;
const SETTINGS_MANIFEST: &str = include_str!("../../../config/settings.manifest.toml");

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
    default: String,
    desktop_default: Option<String>,
    input: Option<String>,
    #[serde(default)]
    secret: bool,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    help: String,
    view: Option<String>,
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

        let input = setting.input.unwrap_or_else(|| "text".to_owned());
        if !matches!(
            input.as_str(),
            "text" | "password" | "checkbox" | "textarea" | "select"
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

        let default_value = setting.desktop_default.unwrap_or(setting.default);
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
            view: setting.view,
        });
    }

    if !errors.is_empty() {
        return Err(format!(
            "Invalid settings manifest:\n- {}",
            errors.join("\n- ")
        ));
    }

    Ok(AppConfigManifestModel {
        groups,
        settings,
        ordered_keys,
        defaults,
    })
}

#[cfg(test)]
mod tests {
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
}
