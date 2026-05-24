use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::app_config_manifest::{
    AppConfigManifestModel, AppConfigManifestSetting, load_app_config_manifest,
};

const SETTINGS_VERSION: u8 = 1;

const DESKTOP_RUNTIME_RESOURCES_DIR_DEFAULT: &str = "runtime";
const DESKTOP_RESTART_BACKOFF_MS_DEFAULT: &str = "1500";
const DESKTOP_WALLET_STORE_DIR_DEFAULT: &str = "wallets";
const DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS_DEFAULT: &str = "5000";
const USERLAND_UI_DIST_DIR_DEFAULT: &str = "frontend/userland";

/// App-data paths used by desktop configuration, rendered env, and logs.
pub struct DesktopConfigPaths {
    pub app_data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub env_file_path: PathBuf,
    pub settings_file_path: PathBuf,
}

/// Transport input for persisting Admin-managed application settings.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAppConfigInput {
    pub values: HashMap<String, String>,
    pub auto_launch_on_startup: bool,
}

/// Admin-facing configuration state and schema.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigState {
    pub configured: bool,
    pub env_file_path: String,
    pub env_file_exists: bool,
    pub settings_file_path: String,
    pub settings_file_exists: bool,
    pub auto_launch_on_startup: bool,
    pub values: HashMap<String, String>,
    pub defaults: HashMap<String, String>,
    pub groups: Vec<AppConfigGroup>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigGroup {
    pub id: String,
    pub label: String,
    pub fields: Vec<AppConfigField>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigField {
    pub key: String,
    pub label: String,
    pub input_kind: String,
    pub secret: bool,
    pub options: Vec<String>,
    pub help: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettingsDocument {
    version: u8,
    created_at: String,
    updated_at: String,
    desktop: DesktopSettings,
    values: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    auto_launch_on_startup: bool,
}

/// Ensures app-data/config/log directories exist without creating runtime `.env`.
pub fn ensure_desktop_config_paths(app: &AppHandle) -> Result<DesktopConfigPaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    fs::create_dir_all(&app_data_dir).map_err(|error| {
        format!(
            "Failed to create app data dir {}: {error}",
            app_data_dir.display()
        )
    })?;

    let config_dir = app_data_dir.join("config");
    let logs_dir = app_data_dir.join("logs");
    fs::create_dir_all(&config_dir).map_err(|error| {
        format!(
            "Failed to create config dir {}: {error}",
            config_dir.display()
        )
    })?;
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("Failed to create logs dir {}: {error}", logs_dir.display()))?;

    Ok(DesktopConfigPaths {
        app_data_dir,
        logs_dir,
        env_file_path: config_dir.join(".env"),
        settings_file_path: config_dir.join("settings.json"),
    })
}

/// Loads the Admin config state without implicitly materializing a runnable `.env`.
pub fn load_app_config_state(app: &AppHandle) -> Result<AppConfigState, String> {
    let paths = ensure_desktop_config_paths(app)?;
    let model = load_app_config_manifest()?;
    let settings = read_settings_document_if_exists(&paths)?;
    Ok(build_app_config_state(&paths, settings.as_ref(), &model))
}

fn build_app_config_state(
    paths: &DesktopConfigPaths,
    settings: Option<&AppSettingsDocument>,
    model: &AppConfigManifestModel,
) -> AppConfigState {
    let defaults = model.defaults.clone();

    let configured = settings.is_some();
    let mut values = defaults.clone();
    if let Some(document) = settings {
        merge_known_values(&mut values, &document.values, &model.ordered_keys);
    }

    let auto_launch_on_startup = settings
        .map(|document| document.desktop.auto_launch_on_startup)
        .unwrap_or(false);

    AppConfigState {
        configured,
        env_file_path: paths.env_file_path.to_string_lossy().into_owned(),
        env_file_exists: paths.env_file_path.exists(),
        settings_file_path: paths.settings_file_path.to_string_lossy().into_owned(),
        settings_file_exists: paths.settings_file_path.exists(),
        auto_launch_on_startup,
        values,
        defaults,
        groups: build_schema_groups(model),
    }
}

/// Persists Admin-managed settings and renders the runtime `.env` from them.
pub fn save_app_config(
    app: &AppHandle,
    input: SaveAppConfigInput,
) -> Result<AppConfigState, String> {
    let paths = ensure_desktop_config_paths(app)?;
    let previous = read_settings_document_if_exists(&paths)?;
    let model = load_app_config_manifest()?;
    let mut values = model.defaults.clone();
    merge_known_values(&mut values, &input.values, &model.ordered_keys);

    let now = now_rfc3339();
    let document = AppSettingsDocument {
        version: SETTINGS_VERSION,
        created_at: previous
            .as_ref()
            .map(|document| document.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        desktop: DesktopSettings {
            auto_launch_on_startup: input.auto_launch_on_startup,
        },
        values,
    };

    write_settings_document(&paths, &document)?;
    render_env_file(&paths, &document, &model)?;
    load_app_config_state(app)
}

/// Persists the built-in desktop defaults and renders the runtime `.env`.
pub fn use_default_app_config(app: &AppHandle) -> Result<AppConfigState, String> {
    let state = load_app_config_state(app)?;
    save_app_config(
        app,
        SaveAppConfigInput {
            values: state.defaults,
            auto_launch_on_startup: false,
        },
    )
}

/// Loads process env from settings/rendered env. `Ok(None)` means first launch is unconfigured.
pub fn load_or_materialize_process_env(
    app: &AppHandle,
) -> Result<Option<HashMap<String, String>>, String> {
    let paths = ensure_desktop_config_paths(app)?;
    if let Some(document) = read_settings_document_if_exists(&paths)? {
        let model = load_app_config_manifest()?;
        let normalized = normalize_settings_document(&document, &model);
        if normalized.values != document.values {
            write_settings_document(&paths, &normalized)?;
        }
        render_env_file(&paths, &normalized, &model)?;
        return parse_env_file(&paths.env_file_path).map(Some);
    }
    Ok(None)
}

/// Parses a dotenv-style file into raw key/value pairs.
pub fn parse_env_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read desktop env file {}: {error}",
            path.display()
        )
    })?;
    Ok(parse_env_content(&content).defaults)
}

fn parse_env_content(content: &str) -> ParsedEnvFile {
    let mut defaults = HashMap::<String, String>::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let value = strip_env_value_comment(raw_value.trim());
        defaults.insert(key.to_owned(), unquote_env_value(value));
    }

    ParsedEnvFile { defaults }
}

struct ParsedEnvFile {
    defaults: HashMap<String, String>,
}

fn strip_env_value_comment(raw: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    let mut previous_was_whitespace = false;
    for (index, character) in raw.char_indices() {
        match character {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double && previous_was_whitespace => {
                return raw[..index].trim_end();
            }
            _ => {}
        }
        previous_was_whitespace = character.is_whitespace();
    }
    raw
}

fn unquote_env_value(raw: &str) -> String {
    if let Some(without_prefix) = raw.strip_prefix('"')
        && let Some(value) = without_prefix.strip_suffix('"')
    {
        return value.to_owned();
    }
    if let Some(without_prefix) = raw.strip_prefix('\'')
        && let Some(value) = without_prefix.strip_suffix('\'')
    {
        return value.to_owned();
    }
    raw.to_owned()
}

fn merge_known_values(
    target: &mut HashMap<String, String>,
    input: &HashMap<String, String>,
    ordered_keys: &[String],
) {
    for key in ordered_keys {
        if let Some(value) = input.get(key) {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn normalize_settings_document(
    document: &AppSettingsDocument,
    model: &AppConfigManifestModel,
) -> AppSettingsDocument {
    let mut values = model.defaults.clone();
    merge_known_values(&mut values, &document.values, &model.ordered_keys);
    AppSettingsDocument {
        version: document.version,
        created_at: document.created_at.clone(),
        updated_at: document.updated_at.clone(),
        desktop: DesktopSettings {
            auto_launch_on_startup: document.desktop.auto_launch_on_startup,
        },
        values,
    }
}

fn read_settings_document_if_exists(
    paths: &DesktopConfigPaths,
) -> Result<Option<AppSettingsDocument>, String> {
    if !paths.settings_file_path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&paths.settings_file_path).map_err(|error| {
        format!(
            "Failed to read app settings {}: {error}",
            paths.settings_file_path.display()
        )
    })?;
    let document: AppSettingsDocument = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Failed to parse app settings {}: {error}",
            paths.settings_file_path.display()
        )
    })?;
    if document.version != SETTINGS_VERSION {
        return Err(format!(
            "Unsupported app settings version {} in {}",
            document.version,
            paths.settings_file_path.display()
        ));
    }
    Ok(Some(document))
}

fn write_settings_document(
    paths: &DesktopConfigPaths,
    document: &AppSettingsDocument,
) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("Failed to serialize app settings: {error}"))?;
    write_private_file_atomic(&paths.settings_file_path, &payload)
}

fn render_env_file(
    paths: &DesktopConfigPaths,
    document: &AppSettingsDocument,
    model: &AppConfigManifestModel,
) -> Result<(), String> {
    let mut output = String::new();
    output.push_str("# ArtGod desktop runtime env\n");
    output.push_str("# Generated from Admin configuration settings.\n\n");
    output.push_str("# Desktop supervisor\n");
    push_env_line(
        &mut output,
        "DESKTOP_RUNTIME_RESOURCES_DIR",
        DESKTOP_RUNTIME_RESOURCES_DIR_DEFAULT,
    );
    push_env_line(
        &mut output,
        "DESKTOP_AUTO_START",
        if document.desktop.auto_launch_on_startup {
            "true"
        } else {
            "false"
        },
    );
    push_env_line(
        &mut output,
        "DESKTOP_RESTART_BACKOFF_MS",
        DESKTOP_RESTART_BACKOFF_MS_DEFAULT,
    );
    push_env_line(
        &mut output,
        "DESKTOP_WALLET_STORE_DIR",
        DESKTOP_WALLET_STORE_DIR_DEFAULT,
    );
    push_env_line(
        &mut output,
        "DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS",
        DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS_DEFAULT,
    );
    push_env_line(
        &mut output,
        "USERLAND_UI_DIST_DIR",
        USERLAND_UI_DIST_DIR_DEFAULT,
    );

    for group in &model.groups {
        let fields = model
            .settings
            .iter()
            .filter(|setting| setting.group == group.id)
            .collect::<Vec<_>>();
        if fields.is_empty() {
            continue;
        }
        output.push('\n');
        output.push_str("# ");
        output.push_str(&group.label);
        output.push('\n');
        for setting in fields {
            let value = document
                .values
                .get(&setting.key)
                .or_else(|| model.defaults.get(&setting.key))
                .map(String::as_str)
                .unwrap_or("");
            push_env_line(&mut output, &setting.key, value);
        }
    }

    write_private_file_atomic(&paths.env_file_path, output.as_bytes())
}

fn push_env_line(output: &mut String, key: &str, value: &str) {
    output.push_str(key);
    output.push('=');
    output.push_str(&quote_env_value(value));
    output.push('\n');
}

fn quote_env_value(value: &str) -> String {
    let needs_quotes = value
        .chars()
        .any(|character| character.is_whitespace() || character == '#');
    if !needs_quotes {
        return value.to_owned();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn build_schema_groups(model: &AppConfigManifestModel) -> Vec<AppConfigGroup> {
    let mut groups = model
        .groups
        .iter()
        .map(|group| AppConfigGroup {
            id: group.id.clone(),
            label: group.label.clone(),
            fields: model
                .settings
                .iter()
                .filter(|setting| setting.group == group.id)
                .map(build_schema_field)
                .collect(),
        })
        .collect::<Vec<_>>();
    groups.insert(
        0,
        AppConfigGroup {
            id: "desktop".to_owned(),
            label: "Desktop".to_owned(),
            fields: Vec::new(),
        },
    );
    groups
}

fn build_schema_field(setting: &AppConfigManifestSetting) -> AppConfigField {
    AppConfigField {
        key: setting.key.clone(),
        label: setting.label.clone(),
        input_kind: setting.input.clone(),
        secret: setting.secret,
        options: setting.options.clone(),
        help: setting.help.clone(),
        view: setting.view.clone(),
    }
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC 3339 formatter should always be valid")
}

fn write_private_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Config path has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create config directory {}: {error}",
            parent.display()
        )
    })?;
    let temp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("config"),
        Uuid::new_v4()
    ));
    write_private_file(&temp_path, bytes)?;
    replace_file(&temp_path, path)?;
    apply_private_file_permissions(path)?;
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to create config file {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("Failed to write config file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync config file {}: {error}", path.display()))?;
    Ok(())
}

fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        if target_path.exists() {
            let backup_path = temp_path.with_extension("bak");
            fs::rename(target_path, &backup_path).map_err(|error| {
                format!(
                    "Failed to prepare config file replacement {}: {error}",
                    target_path.display()
                )
            })?;
            match fs::rename(temp_path, target_path) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup_path);
                    Ok(())
                }
                Err(error) => {
                    let _ = fs::rename(&backup_path, target_path);
                    Err(format!(
                        "Failed to replace config file {}: {error}",
                        target_path.display()
                    ))
                }
            }
        } else {
            fs::rename(temp_path, target_path).map_err(|error| {
                format!(
                    "Failed to move config file into place {}: {error}",
                    target_path.display()
                )
            })
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(temp_path, target_path).map_err(|error| {
            format!(
                "Failed to move config file into place {}: {error}",
                target_path.display()
            )
        })
    }
}

fn apply_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Failed to restrict config file permissions {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_file_parser_strips_inline_comments() {
        let model = parse_env_content("RPC_RATE_LIMIT_REQUESTS_PER_SECOND=50 # use 0\nA='x # y'\n");

        assert_eq!(
            model.defaults.get("RPC_RATE_LIMIT_REQUESTS_PER_SECOND"),
            Some(&"50".to_owned())
        );
        assert_eq!(model.defaults.get("A"), Some(&"x # y".to_owned()));
    }

    #[test]
    fn schema_contains_every_manifest_key_once() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let fields = build_schema_groups(&model)
            .into_iter()
            .flat_map(|group| group.fields)
            .collect::<Vec<_>>();

        assert_eq!(fields.len(), model.ordered_keys.len());
        for key in model.ordered_keys {
            assert!(fields.iter().any(|field| field.key == key));
        }
    }

    #[test]
    fn rendered_env_includes_desktop_keys_and_manifest_keys() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let document = AppSettingsDocument {
            version: SETTINGS_VERSION,
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            desktop: DesktopSettings {
                auto_launch_on_startup: true,
            },
            values: model.defaults.clone(),
        };
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DesktopConfigPaths {
            app_data_dir: temp.path().to_path_buf(),
            logs_dir: temp.path().join("logs"),
            env_file_path: temp.path().join(".env"),
            settings_file_path: temp.path().join("settings.json"),
        };

        render_env_file(&paths, &document, &model).expect("render env");
        let rendered = fs::read_to_string(paths.env_file_path).expect("read env");

        assert!(rendered.contains("DESKTOP_AUTO_START=true\n"));
        assert!(rendered.contains("USERLAND_UI_DIST_DIR=frontend/userland\n"));
        assert!(rendered.contains("ARTGOD_DB_PATH=sqlite/main/db\n"));
        assert!(rendered.contains("BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION="));
    }

    #[test]
    fn app_state_does_not_treat_legacy_env_as_configured() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DesktopConfigPaths {
            app_data_dir: temp.path().to_path_buf(),
            logs_dir: temp.path().join("logs"),
            env_file_path: temp.path().join(".env"),
            settings_file_path: temp.path().join("settings.json"),
        };
        fs::write(&paths.env_file_path, "DESKTOP_AUTO_START=true\n").expect("write env");

        let state = build_app_config_state(&paths, None, &model);

        assert!(!state.configured);
        assert!(!state.auto_launch_on_startup);
        assert!(state.env_file_exists);
        assert!(!state.settings_file_exists);
    }

    #[test]
    fn normalize_settings_document_adds_new_manifest_defaults() {
        let model = load_app_config_manifest().expect("load settings manifest");
        let document = AppSettingsDocument {
            version: SETTINGS_VERSION,
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            desktop: DesktopSettings {
                auto_launch_on_startup: false,
            },
            values: HashMap::from([("ARTGOD_DB_PATH".to_owned(), "custom.sqlite".to_owned())]),
        };

        let normalized = normalize_settings_document(&document, &model);

        assert_eq!(
            normalized.values.get("ARTGOD_DB_PATH"),
            Some(&"custom.sqlite".to_owned())
        );
        assert_eq!(
            normalized.values.get("BIDDING_COMMAND_POLL_MS"),
            Some(&"1000".to_owned())
        );
        assert_eq!(normalized.values.len(), model.ordered_keys.len());
    }
}
