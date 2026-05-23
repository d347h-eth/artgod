use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const SETTINGS_VERSION: u8 = 1;
const ENV_EXAMPLE: &str = include_str!("../../../.env.example");

const DESKTOP_RUNTIME_RESOURCES_DIR_DEFAULT: &str = "runtime";
const DESKTOP_RESTART_BACKOFF_MS_DEFAULT: &str = "1500";
const DESKTOP_WALLET_STORE_DIR_DEFAULT: &str = "wallets";
const DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS_DEFAULT: &str = "5000";
const USERLAND_UI_DIST_DIR_DEFAULT: &str = "frontend/userland";
const ARTGOD_DESKTOP_DB_PATH_DEFAULT: &str = "sqlite/main/db";

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
    pub settings_file_path: String,
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

struct EnvExampleModel {
    ordered_keys: Vec<String>,
    defaults: HashMap<String, String>,
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
    let model = env_example_model();
    let settings = read_settings_document_if_exists(&paths)?;
    let env_values = if settings.is_none() && paths.env_file_path.exists() {
        Some(parse_env_file(&paths.env_file_path)?)
    } else {
        None
    };

    let mut defaults = model.defaults.clone();
    apply_desktop_default_overrides(&mut defaults);

    let configured = settings.is_some() || env_values.is_some();
    let mut values = defaults.clone();
    if let Some(document) = &settings {
        merge_known_values(&mut values, &document.values, &model.ordered_keys);
    } else if let Some(env_values) = &env_values {
        merge_known_values(&mut values, env_values, &model.ordered_keys);
    }

    let auto_launch_on_startup = settings
        .as_ref()
        .map(|document| document.desktop.auto_launch_on_startup)
        .or_else(|| {
            env_values
                .as_ref()
                .and_then(|values| values.get("DESKTOP_AUTO_START"))
                .and_then(|value| parse_bool(value).ok())
        })
        .unwrap_or(false);

    Ok(AppConfigState {
        configured,
        env_file_path: paths.env_file_path.to_string_lossy().into_owned(),
        settings_file_path: paths.settings_file_path.to_string_lossy().into_owned(),
        auto_launch_on_startup,
        values,
        defaults,
        groups: build_schema_groups(&model.ordered_keys),
    })
}

/// Persists Admin-managed settings and renders the runtime `.env` from them.
pub fn save_app_config(
    app: &AppHandle,
    input: SaveAppConfigInput,
) -> Result<AppConfigState, String> {
    let paths = ensure_desktop_config_paths(app)?;
    let previous = read_settings_document_if_exists(&paths)?;
    let model = env_example_model();
    let mut values = model.defaults.clone();
    apply_desktop_default_overrides(&mut values);
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
    render_env_file(&paths, &document, &model.ordered_keys)?;
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
        render_env_file(&paths, &document, &env_example_model().ordered_keys)?;
        return parse_env_file(&paths.env_file_path).map(Some);
    }
    if paths.env_file_path.exists() {
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

fn env_example_model() -> EnvExampleModel {
    let mut model = parse_env_content(ENV_EXAMPLE);
    apply_desktop_default_overrides(&mut model.defaults);
    model
}

fn parse_env_content(content: &str) -> EnvExampleModel {
    let mut ordered_keys = Vec::<String>::new();
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
        if !defaults.contains_key(key) {
            ordered_keys.push(key.to_owned());
        }
        defaults.insert(key.to_owned(), unquote_env_value(value));
    }

    EnvExampleModel {
        ordered_keys,
        defaults,
    }
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

fn apply_desktop_default_overrides(values: &mut HashMap<String, String>) {
    values.insert(
        "ARTGOD_DB_PATH".to_owned(),
        ARTGOD_DESKTOP_DB_PATH_DEFAULT.to_owned(),
    );
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
    ordered_keys: &[String],
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

    let mut last_group = String::new();
    for key in ordered_keys {
        let group = group_for_key(key);
        if group.id != last_group {
            output.push('\n');
            output.push_str("# ");
            output.push_str(group.label);
            output.push('\n');
            last_group = group.id.to_owned();
        }
        let value = document.values.get(key).map(String::as_str).unwrap_or("");
        push_env_line(&mut output, key, value);
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

fn build_schema_groups(ordered_keys: &[String]) -> Vec<AppConfigGroup> {
    let mut groups = Vec::<AppConfigGroup>::new();
    for key in ordered_keys {
        let group_info = group_for_key(key);
        if !groups.iter().any(|group| group.id == group_info.id) {
            groups.push(AppConfigGroup {
                id: group_info.id.to_owned(),
                label: group_info.label.to_owned(),
                fields: Vec::new(),
            });
        }
        let field = AppConfigField {
            key: key.clone(),
            label: key_label(key),
            input_kind: input_kind_for_key(key).to_owned(),
            secret: is_secret_key(key),
            options: options_for_key(key),
        };
        if let Some(group) = groups.iter_mut().find(|group| group.id == group_info.id) {
            group.fields.push(field);
        }
    }
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

struct GroupInfo {
    id: &'static str,
    label: &'static str,
}

fn group_for_key(key: &str) -> GroupInfo {
    if key.starts_with("BACKEND_QUERY_CACHE_") {
        return GroupInfo {
            id: "backend-cache",
            label: "Backend Cache",
        };
    }
    if key.starts_with("BACKEND_METRICS_") || key.starts_with("BACKEND_APM_") {
        return GroupInfo {
            id: "backend-observability",
            label: "Backend Observability",
        };
    }
    if key.starts_with("BACKEND_") || key == "PUBLIC_BACKEND_ORIGIN" {
        return GroupInfo {
            id: "backend",
            label: "Backend",
        };
    }
    if key.starts_with("RPC_")
        || key == "ARTGOD_DB_PATH"
        || key == "CHAIN_ID"
        || key == "WETH_ADDRESS"
        || key == "SEAPORT_CONDUIT_CONTROLLER"
    {
        return GroupInfo {
            id: "chain-rpc",
            label: "Chain and RPC",
        };
    }
    if key.starts_with("NATS_") {
        return GroupInfo {
            id: "queue",
            label: "Queue",
        };
    }
    if key.starts_with("OBSERVABILITY_")
        || key.starts_with("INDEXER_METRICS_")
        || key.starts_with("INDEXER_APM_")
    {
        return GroupInfo {
            id: "observability",
            label: "Indexer Observability",
        };
    }
    if key.starts_with("OPENSEA_") && key.ends_with("_SECRET_KEY") {
        return GroupInfo {
            id: "trading-opensea",
            label: "Trading OpenSea",
        };
    }
    if key.starts_with("OPENSEA_") {
        return GroupInfo {
            id: "opensea",
            label: "OpenSea",
        };
    }
    if key.starts_with("BIDDING_") {
        return GroupInfo {
            id: "bidding",
            label: "Bidding",
        };
    }
    GroupInfo {
        id: "indexer",
        label: "Indexer",
    }
}

fn key_label(key: &str) -> String {
    key.to_ascii_lowercase().replace('_', " ")
}

fn input_kind_for_key(key: &str) -> &'static str {
    if options_for_key(key).is_empty() {
        if key.ends_with("_BY_COLLECTION") {
            "textarea"
        } else if is_boolean_key(key) {
            "checkbox"
        } else if is_secret_key(key) {
            "password"
        } else {
            "text"
        }
    } else {
        "select"
    }
}

fn options_for_key(key: &str) -> Vec<String> {
    match key {
        "OPENSEA_INTEGRATION_MODE" => vec![
            "auto".to_owned(),
            "enabled".to_owned(),
            "disabled".to_owned(),
        ],
        "BACKEND_QUERY_CACHE_PROVIDER" => vec!["disabled".to_owned(), "memory".to_owned()],
        "BIDDING_TX_PENDING_NONCE_POLICY" => vec!["fail".to_owned(), "latest".to_owned()],
        _ => Vec::new(),
    }
}

fn is_boolean_key(key: &str) -> bool {
    key.ends_with("_ENABLED")
        || key.ends_with("_SECURE")
        || key == "BIDDING_DRY_RUN"
        || key == "OFFCHAIN_PERSIST_RAW_OBSERVATIONS"
}

fn is_secret_key(key: &str) -> bool {
    key.contains("API_KEY") || key.contains("SECRET_KEY") || key.contains("PASSWORD")
}

fn parse_bool(raw: &str) -> Result<bool, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "Invalid boolean value \"{raw}\". Use true/false, 1/0, yes/no, on/off."
        )),
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
    fn env_example_parser_strips_inline_comments() {
        let model = parse_env_content("RPC_RATE_LIMIT_REQUESTS_PER_SECOND=50 # use 0\nA='x # y'\n");

        assert_eq!(
            model.defaults.get("RPC_RATE_LIMIT_REQUESTS_PER_SECOND"),
            Some(&"50".to_owned())
        );
        assert_eq!(model.defaults.get("A"), Some(&"x # y".to_owned()));
    }

    #[test]
    fn schema_contains_every_env_example_key_once() {
        let model = env_example_model();
        let fields = build_schema_groups(&model.ordered_keys)
            .into_iter()
            .flat_map(|group| group.fields)
            .collect::<Vec<_>>();

        assert_eq!(fields.len(), model.ordered_keys.len());
        for key in model.ordered_keys {
            assert!(fields.iter().any(|field| field.key == key));
        }
    }

    #[test]
    fn rendered_env_includes_desktop_keys_and_example_keys() {
        let model = env_example_model();
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

        render_env_file(&paths, &document, &model.ordered_keys).expect("render env");
        let rendered = fs::read_to_string(paths.env_file_path).expect("read env");

        assert!(rendered.contains("DESKTOP_AUTO_START=true\n"));
        assert!(rendered.contains("USERLAND_UI_DIST_DIR=frontend/userland\n"));
        assert!(rendered.contains("ARTGOD_DB_PATH=sqlite/main/db\n"));
        assert!(rendered.contains("BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION="));
    }
}
