use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::app_config::{ensure_desktop_config_paths, load_or_materialize_process_env};
use super::bot_runtime::BotRuntimeSpec;
use super::env_keys::{COMMON_MEDIA_CACHE_DIR_ENV_KEY, RPC_ENDPOINT_LIST_ENV_KEY};
use super::resource_contract::{
    BUNDLED_RUNTIME_DIR_NAME, MACOS_BUNDLE_RESOURCES_DIR_NAME, NATS_BINARY_RELATIVE_PATH,
    NODE_BINARY_RELATIVE_PATH, PNP_CJS_RELATIVE_PATH, PNP_LOADER_RELATIVE_PATH,
    TAURI_BUNDLED_RESOURCES_DIR_NAME,
};
use super::runtime_integrity::verify_wallet_recipient_runtime;

pub struct DesktopRuntimeConfig {
    pub env_file_path: PathBuf,
    pub node_bin: PathBuf,
    pub nats_bin: PathBuf,
    pub nats_store_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub pnp_cjs_path: PathBuf,
    pub pnp_loader_path: PathBuf,
    pub nats_host: String,
    pub nats_port: u16,
    pub nats_url: String,
    pub backend_port: u16,
    pub chain_id: u64,
    pub auto_start: bool,
    pub restart_backoff_ms: u64,
    pub process_env: HashMap<String, String>,
    pub logs_dir: PathBuf,
    pub capabilities: DesktopRuntimeCapabilities,
    #[allow(dead_code)]
    pub wallet: DesktopWalletConfig,
}

/// Immutable executable/config snapshot used from native unlock through bot spawn.
pub(crate) struct BotRuntimeLaunchConfig {
    pub(crate) spec: BotRuntimeSpec,
    pub(crate) artifact_path: PathBuf,
    pub(crate) node_bin: PathBuf,
    pub(crate) runtime_dir: PathBuf,
    pub(crate) pnp_cjs_path: PathBuf,
    pub(crate) pnp_loader_path: PathBuf,
    pub(crate) chain_id: u64,
    pub(crate) process_env: HashMap<String, String>,
    pub(crate) logs_dir: PathBuf,
}

/// App-data child directory passed as the embedded NATS store root.
pub(crate) const NATS_STORAGE_DIR_NAME: &str = "nats";

#[derive(Clone, Debug)]
pub struct DesktopRuntimeCapabilities {
    pub opensea: RuntimeCapability,
}

#[derive(Clone, Debug)]
pub struct RuntimeCapability {
    pub enabled: bool,
    pub mode: String,
    pub reason: Option<String>,
    #[allow(dead_code)]
    pub missing_keys: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct DesktopWalletConfig {
    pub store_dir: PathBuf,
    pub index_path: PathBuf,
    #[allow(dead_code)]
    pub bot_unlock_stabilization_delay_ms: u64,
}

impl DesktopWalletConfig {
    pub fn load_or_create(app: &AppHandle) -> Result<Self, String> {
        let local_paths = ensure_desktop_config_paths(app)?;
        let process_env = load_or_materialize_process_env(app)?.unwrap_or_default();
        build_wallet_config(&local_paths.app_data_dir, &process_env)
    }
}

impl DesktopRuntimeConfig {
    pub fn load_process_env(app: &AppHandle) -> Result<HashMap<String, String>, String> {
        Ok(load_or_materialize_process_env(app)?.unwrap_or_default())
    }

    pub fn load_capabilities(app: &AppHandle) -> Result<DesktopRuntimeCapabilities, String> {
        let process_env = Self::load_process_env(app)?;
        build_runtime_capabilities(&process_env)
    }

    pub fn load_or_create(app: &AppHandle) -> Result<Self, String> {
        let local_paths = ensure_desktop_config_paths(app)?;
        let app_data_dir = local_paths.app_data_dir.clone();
        let env_file_path = local_paths.env_file_path.clone();
        let Some(process_env) = load_or_materialize_process_env(app)? else {
            return Err("Desktop configuration has not been saved yet.".to_owned());
        };

        let runtime_dir = resolve_runtime_resources_dir(app)?;
        let node_bin = resolve_bundled_runtime_file(
            &runtime_dir,
            NODE_BINARY_RELATIVE_PATH,
            "Desktop Node binary",
        )?;
        let nats_bin = resolve_bundled_runtime_file(
            &runtime_dir,
            NATS_BINARY_RELATIVE_PATH,
            "Desktop NATS binary",
        )?;
        let nats_store_dir = build_nats_store_dir(&app_data_dir)?;
        let pnp_cjs_path = resolve_bundled_runtime_file(
            &runtime_dir,
            PNP_CJS_RELATIVE_PATH,
            "Yarn PnP CommonJS hook",
        )?;
        let pnp_loader_path = resolve_bundled_runtime_file(
            &runtime_dir,
            PNP_LOADER_RELATIVE_PATH,
            "Yarn PnP ESM loader",
        )?;
        let backend_port = parse_port(get_required(&process_env, "BACKEND_PORT")?)?;
        let chain_id = parse_u64(get_required(&process_env, "CHAIN_ID")?)?;
        let auto_start = parse_bool(get_required(&process_env, "DESKTOP_AUTO_START")?)?;
        let restart_backoff_ms =
            parse_u64(get_required(&process_env, "DESKTOP_RESTART_BACKOFF_MS")?)?;
        let wallet = build_wallet_config(&app_data_dir, &process_env)?;
        let capabilities = build_runtime_capabilities(&process_env)?;
        validate_runtime_capabilities(&capabilities)?;

        // Core runtime env is required for backend/indexer startup.
        get_required(&process_env, "ARTGOD_DB_PATH")?;
        let nats_url = get_required(&process_env, "NATS_URL")?.to_owned();
        let (nats_host, nats_port) = parse_nats_url(&nats_url)?;
        get_required(&process_env, RPC_ENDPOINT_LIST_ENV_KEY)?;
        get_required(&process_env, "WETH_ADDRESS")?;
        get_required(&process_env, "SEAPORT_CONDUIT_CONTROLLER")?;
        get_required(&process_env, "USERLAND_UI_DIST_DIR")?;

        let db_path =
            resolve_from_base_dir(&app_data_dir, get_required(&process_env, "ARTGOD_DB_PATH")?);
        if let Some(parent_dir) = db_path.parent() {
            fs::create_dir_all(parent_dir).map_err(|error| {
                format!(
                    "Failed to create desktop DB directory {}: {error}",
                    parent_dir.display()
                )
            })?;
        }
        let media_cache_dir = process_env
            .get(COMMON_MEDIA_CACHE_DIR_ENV_KEY)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| resolve_from_base_dir(&app_data_dir, value));
        if let Some(media_cache_dir) = media_cache_dir.as_ref() {
            fs::create_dir_all(media_cache_dir).map_err(|error| {
                format!(
                    "Failed to create desktop media cache directory {}: {error}",
                    media_cache_dir.display()
                )
            })?;
        }
        let userland_ui_dist_dir = resolve_from_base_dir(
            &runtime_dir,
            get_required(&process_env, "USERLAND_UI_DIST_DIR")?,
        );
        if !userland_ui_dist_dir.exists() {
            return Err(format!(
                "USERLAND_UI_DIST_DIR does not exist: {}",
                userland_ui_dist_dir.display()
            ));
        }
        let mut merged_env = process_env.clone();
        merged_env.insert(
            "ARTGOD_ENV_FILE".to_owned(),
            env_file_path.to_string_lossy().into_owned(),
        );
        merged_env.insert(
            "ARTGOD_WORKSPACE_ROOT".to_owned(),
            runtime_dir.to_string_lossy().into_owned(),
        );
        merged_env.insert(
            "ARTGOD_DB_PATH".to_owned(),
            db_path.to_string_lossy().into_owned(),
        );
        if let Some(media_cache_dir) = media_cache_dir {
            merged_env.insert(
                COMMON_MEDIA_CACHE_DIR_ENV_KEY.to_owned(),
                media_cache_dir.to_string_lossy().into_owned(),
            );
        }
        merged_env.insert(
            "USERLAND_UI_DIST_DIR".to_owned(),
            userland_ui_dist_dir.to_string_lossy().into_owned(),
        );
        merged_env.insert("BACKEND_PORT".to_owned(), backend_port.to_string());

        Ok(Self {
            env_file_path,
            node_bin,
            nats_bin,
            nats_store_dir,
            runtime_dir,
            pnp_cjs_path,
            pnp_loader_path,
            nats_host,
            nats_port,
            nats_url,
            backend_port,
            chain_id,
            auto_start,
            restart_backoff_ms,
            process_env: merged_env,
            logs_dir: local_paths.logs_dir,
            capabilities,
            wallet,
        })
    }

    pub fn backend_http_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.backend_port)
    }

    pub fn nats_url(&self) -> String {
        self.nats_url.clone()
    }

    /// Freezes the exact trusted recipient and process environment before an unlock prompt.
    pub(crate) fn bot_runtime_launch_config(
        &self,
        spec: BotRuntimeSpec,
    ) -> Result<BotRuntimeLaunchConfig, String> {
        let artifact_path = resolve_bundled_runtime_file(
            &self.runtime_dir,
            spec.artifact_relative_path,
            "Trading bot runtime artifact",
        )?;
        verify_wallet_recipient_runtime(
            &self.runtime_dir,
            &[
                &self.node_bin,
                &self.pnp_cjs_path,
                &self.pnp_loader_path,
                &artifact_path,
            ],
        )?;

        Ok(BotRuntimeLaunchConfig {
            spec,
            artifact_path,
            node_bin: self.node_bin.clone(),
            runtime_dir: self.runtime_dir.clone(),
            pnp_cjs_path: self.pnp_cjs_path.clone(),
            pnp_loader_path: self.pnp_loader_path.clone(),
            chain_id: self.chain_id,
            process_env: self.process_env.clone(),
            logs_dir: self.logs_dir.clone(),
        })
    }
}

fn build_nats_store_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    let nats_store_dir = app_data_dir.join(NATS_STORAGE_DIR_NAME);
    fs::create_dir_all(&nats_store_dir).map_err(|error| {
        format!(
            "Failed to create NATS store dir {}: {error}",
            nats_store_dir.display()
        )
    })?;
    Ok(nats_store_dir)
}

fn build_wallet_config(
    app_data_dir: &Path,
    process_env: &HashMap<String, String>,
) -> Result<DesktopWalletConfig, String> {
    let wallet_store_dir = resolve_from_base_dir(
        app_data_dir,
        process_env
            .get("DESKTOP_WALLET_STORE_DIR")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("wallets"),
    );
    fs::create_dir_all(&wallet_store_dir).map_err(|error| {
        format!(
            "Failed to create wallet store dir {}: {error}",
            wallet_store_dir.display()
        )
    })?;
    let bot_unlock_stabilization_delay_ms = parse_u64(
        process_env
            .get("DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("5000"),
    )?;

    Ok(DesktopWalletConfig {
        store_dir: wallet_store_dir.clone(),
        index_path: wallet_store_dir.join("index.json"),
        bot_unlock_stabilization_delay_ms,
    })
}

fn build_runtime_capabilities(
    process_env: &HashMap<String, String>,
) -> Result<DesktopRuntimeCapabilities, String> {
    Ok(DesktopRuntimeCapabilities {
        opensea: resolve_opensea_capability(process_env)?,
    })
}

fn validate_runtime_capabilities(capabilities: &DesktopRuntimeCapabilities) -> Result<(), String> {
    if capabilities.opensea.mode == "enabled" && !capabilities.opensea.enabled {
        return Err(capabilities
            .opensea
            .reason
            .clone()
            .unwrap_or_else(|| "OpenSea integration is enabled but unavailable".to_owned()));
    }
    Ok(())
}

fn resolve_opensea_capability(
    process_env: &HashMap<String, String>,
) -> Result<RuntimeCapability, String> {
    let mode = parse_opensea_integration_mode(process_env.get("OPENSEA_INTEGRATION_MODE"))?;
    let api_key = process_env
        .get("OPENSEA_API_KEY")
        .map(String::as_str)
        .unwrap_or("")
        .trim();

    if mode == "disabled" {
        return Ok(RuntimeCapability {
            enabled: false,
            mode,
            reason: Some("OPENSEA_INTEGRATION_MODE=disabled".to_owned()),
            missing_keys: Vec::new(),
        });
    }

    if !api_key.is_empty() {
        return Ok(RuntimeCapability {
            enabled: true,
            mode,
            reason: None,
            missing_keys: Vec::new(),
        });
    }

    let reason = if mode == "enabled" {
        "OpenSea integration is enabled but OPENSEA_API_KEY is not configured"
    } else {
        "OpenSea integration disabled because OPENSEA_API_KEY is not configured"
    };
    Ok(RuntimeCapability {
        enabled: false,
        mode,
        reason: Some(reason.to_owned()),
        missing_keys: vec!["OPENSEA_API_KEY".to_owned()],
    })
}

fn parse_opensea_integration_mode(raw: Option<&String>) -> Result<String, String> {
    let normalized = raw
        .map(String::as_str)
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return Ok("auto".to_owned());
    }
    match normalized.as_str() {
        "auto" | "enabled" | "disabled" => Ok(normalized),
        _ => Err(format!(
            "Invalid OPENSEA_INTEGRATION_MODE: {}. Use auto, enabled, or disabled.",
            raw.map(String::as_str).unwrap_or("")
        )),
    }
}

fn get_required<'a>(values: &'a HashMap<String, String>, key: &str) -> Result<&'a str, String> {
    let Some(value) = values.get(key) else {
        return Err(format!("Missing required env key in desktop config: {key}"));
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("Desktop config key is empty but required: {key}"));
    }
    Ok(trimmed)
}

fn parse_port(raw: &str) -> Result<u16, String> {
    raw.parse::<u16>()
        .map_err(|error| format!("Invalid port value \"{raw}\": {error}"))
}

fn parse_nats_url(raw: &str) -> Result<(String, u16), String> {
    let trimmed = raw.trim();
    let without_scheme = trimmed
        .strip_prefix("nats://")
        .ok_or_else(|| format!("Invalid NATS_URL \"{raw}\": expected nats://<host>:<port>"))?;
    let authority = without_scheme.split('/').next().unwrap_or("").trim();
    if authority.is_empty() {
        return Err(format!(
            "Invalid NATS_URL \"{raw}\": missing authority section",
        ));
    }

    let host_port = authority
        .rsplit_once('@')
        .map(|(_, value)| value)
        .unwrap_or(authority);

    let (host, raw_port) = if let Some(rest) = host_port.strip_prefix('[') {
        let Some(end_idx) = rest.find(']') else {
            return Err(format!(
                "Invalid NATS_URL \"{raw}\": malformed IPv6 host segment",
            ));
        };
        let host = &rest[..end_idx];
        let after = &rest[end_idx + 1..];
        let Some(raw_port) = after.strip_prefix(':') else {
            return Err(format!(
                "Invalid NATS_URL \"{raw}\": missing port after IPv6 host",
            ));
        };
        (host.trim(), raw_port.trim())
    } else {
        let Some((host, raw_port)) = host_port.rsplit_once(':') else {
            return Err(format!("Invalid NATS_URL \"{raw}\": missing host or port",));
        };
        (host.trim(), raw_port.trim())
    };

    if host.is_empty() {
        return Err(format!("Invalid NATS_URL \"{raw}\": host is empty"));
    }
    if !is_loopback_host(host) {
        return Err(format!(
            "Invalid NATS_URL \"{raw}\": desktop runtime requires loopback host (localhost, 127.0.0.1, ::1)",
        ));
    }
    let port = parse_port(raw_port)?;
    Ok((host.to_owned(), port))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

fn parse_u64(raw: &str) -> Result<u64, String> {
    raw.parse::<u64>()
        .map_err(|error| format!("Invalid integer value \"{raw}\": {error}"))
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

fn resolve_from_base_dir(base_dir: &Path, raw_path: &str) -> PathBuf {
    let raw = PathBuf::from(raw_path);
    if raw.is_absolute() {
        return raw;
    }
    base_dir.join(raw)
}

fn resolve_runtime_resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().ok();
    let current_exe = std::env::current_exe().ok();
    let exe_dir = current_exe.as_deref().and_then(Path::parent);
    let candidates = build_runtime_resources_dir_candidates(resource_dir.as_deref(), exe_dir);

    for candidate in &candidates {
        if !candidate.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(candidate).map_err(|error| {
            format!(
                "Failed to inspect bundled runtime resources {}: {error}",
                candidate.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Bundled runtime resources directory must not be a symbolic link: {}",
                candidate.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Bundled runtime resources path is not a directory: {}",
                candidate.display()
            ));
        }
        return fs::canonicalize(candidate).map_err(|error| {
            format!(
                "Failed to canonicalize bundled runtime resources {}: {error}",
                candidate.display()
            )
        });
    }

    let checked = if candidates.is_empty() {
        "none".to_owned()
    } else {
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };

    Err(format!(
        "DESKTOP runtime resources directory not found. Checked: {checked}. Build runtime resources with `yarn build:runtime && yarn build:desktop-runtime-resources`.",
    ))
}

fn build_runtime_resources_dir_candidates(
    resource_dir: Option<&Path>,
    exe_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join(BUNDLED_RUNTIME_DIR_NAME));
        candidates.push(resolve_from_base_dir(
            resource_dir,
            &format!("{TAURI_BUNDLED_RESOURCES_DIR_NAME}/{BUNDLED_RUNTIME_DIR_NAME}"),
        ));
    }

    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join(BUNDLED_RUNTIME_DIR_NAME));
        candidates.push(resolve_from_base_dir(
            exe_dir,
            &format!("{TAURI_BUNDLED_RESOURCES_DIR_NAME}/{BUNDLED_RUNTIME_DIR_NAME}"),
        ));
        candidates.push(resolve_from_base_dir(
            exe_dir,
            &format!("../{MACOS_BUNDLE_RESOURCES_DIR_NAME}/{BUNDLED_RUNTIME_DIR_NAME}"),
        ));
    }

    let mut seen = HashSet::<String>::new();
    candidates.retain(|path| seen.insert(path.to_string_lossy().to_string()));
    candidates
}

fn resolve_bundled_runtime_file(
    runtime_dir: &Path,
    relative_path: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative_path);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "{label} path must be a normalized bundled-resource path: {}",
            relative_path.display()
        ));
    }
    let candidate = runtime_dir.join(relative_path);
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("{label} is unavailable at {}: {error}", candidate.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{label} must not be a symbolic link: {}",
            candidate.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!("{label} is not a file: {}", candidate.display()));
    }
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "Failed to canonicalize {label} {}: {error}",
            candidate.display()
        )
    })?;
    if !canonical.starts_with(runtime_dir) {
        return Err(format!(
            "{label} escapes bundled runtime resources: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::bot_runtime::BIDDING_BOT_SPEC;

    fn write_runtime_file(runtime_dir: &Path, relative_path: &str) -> PathBuf {
        let path = runtime_dir.join(relative_path);
        fs::create_dir_all(path.parent().expect("runtime file parent")).expect("create parent");
        fs::write(&path, relative_path.as_bytes()).expect("write runtime file");
        fs::canonicalize(path).expect("canonical runtime file")
    }

    fn build_snapshot_test_config(runtime_dir: &Path) -> DesktopRuntimeConfig {
        let runtime_dir = fs::canonicalize(runtime_dir).expect("canonical runtime dir");
        let node_bin = write_runtime_file(&runtime_dir, NODE_BINARY_RELATIVE_PATH);
        let nats_bin = write_runtime_file(&runtime_dir, NATS_BINARY_RELATIVE_PATH);
        let pnp_cjs_path = write_runtime_file(&runtime_dir, PNP_CJS_RELATIVE_PATH);
        let pnp_loader_path = write_runtime_file(&runtime_dir, PNP_LOADER_RELATIVE_PATH);
        write_runtime_file(&runtime_dir, BIDDING_BOT_SPEC.artifact_relative_path);
        let app_data_dir = runtime_dir.join("app-data");

        DesktopRuntimeConfig {
            env_file_path: app_data_dir.join("config/.env"),
            node_bin,
            nats_bin,
            nats_store_dir: app_data_dir.join(NATS_STORAGE_DIR_NAME),
            runtime_dir: runtime_dir.clone(),
            pnp_cjs_path,
            pnp_loader_path,
            nats_host: "127.0.0.1".to_owned(),
            nats_port: 42720,
            nats_url: "nats://127.0.0.1:42720".to_owned(),
            backend_port: 42710,
            chain_id: 1,
            auto_start: true,
            restart_backoff_ms: 1_500,
            process_env: HashMap::from([(
                COMMON_MEDIA_CACHE_DIR_ENV_KEY.to_owned(),
                app_data_dir.join("media").to_string_lossy().into_owned(),
            )]),
            logs_dir: app_data_dir.join("logs"),
            capabilities: build_runtime_capabilities(&HashMap::new())
                .expect("test capabilities should resolve"),
            wallet: DesktopWalletConfig {
                store_dir: app_data_dir.join("wallets"),
                index_path: app_data_dir.join("wallets/index.json"),
                bot_unlock_stabilization_delay_ms: 5_000,
            },
        }
    }

    #[test]
    fn opensea_auto_without_api_key_is_disabled() {
        let capabilities =
            build_runtime_capabilities(&HashMap::new()).expect("capabilities should resolve");

        assert!(!capabilities.opensea.enabled);
        assert_eq!(capabilities.opensea.mode, "auto");
        assert_eq!(
            capabilities.opensea.reason.as_deref(),
            Some("OpenSea integration disabled because OPENSEA_API_KEY is not configured")
        );
        assert_eq!(capabilities.opensea.missing_keys, vec!["OPENSEA_API_KEY"]);
    }

    #[test]
    fn opensea_enabled_without_api_key_is_invalid() {
        let capabilities = build_runtime_capabilities(&HashMap::from([(
            "OPENSEA_INTEGRATION_MODE".to_owned(),
            "enabled".to_owned(),
        )]))
        .expect("capabilities should parse");

        let error = validate_runtime_capabilities(&capabilities)
            .expect_err("enabled OpenSea without an API key should fail");

        assert_eq!(
            error,
            "OpenSea integration is enabled but OPENSEA_API_KEY is not configured"
        );
    }

    #[test]
    fn opensea_auto_with_api_key_is_enabled() {
        let capabilities = build_runtime_capabilities(&HashMap::from([(
            "OPENSEA_API_KEY".to_owned(),
            "test-opensea-api-key".to_owned(),
        )]))
        .expect("capabilities should resolve");

        assert!(capabilities.opensea.enabled);
        assert_eq!(capabilities.opensea.mode, "auto");
        assert!(capabilities.opensea.reason.is_none());
    }

    #[test]
    fn nats_store_dir_is_the_nats_root_under_app_data() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store_dir = build_nats_store_dir(temp.path()).expect("NATS store dir should resolve");

        assert_eq!(store_dir, temp.path().join(NATS_STORAGE_DIR_NAME));
        assert!(store_dir.exists());
    }

    #[test]
    fn runtime_resource_candidates_include_appimage_resource_layout() {
        let resource_dir = Path::new("/tmp/.mount_ArtGod/usr/lib/ArtGod");
        let exe_dir = Path::new("/tmp/.mount_ArtGod/usr/bin");

        let candidates = build_runtime_resources_dir_candidates(Some(resource_dir), Some(exe_dir));

        assert!(candidates.contains(&resource_dir.join("resources/runtime")));
        assert!(candidates.contains(&resource_dir.join("runtime")));
        assert!(candidates.contains(&exe_dir.join("runtime")));
    }

    #[test]
    fn bot_launch_snapshot_ignores_config_mutation_while_prompt_is_open() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut config = build_snapshot_test_config(temp.path());
        let launch = config
            .bot_runtime_launch_config(BIDDING_BOT_SPEC)
            .expect("launch config should freeze");
        let original_node = launch.node_bin.clone();
        let original_runtime_dir = launch.runtime_dir.clone();
        let original_pnp_cjs = launch.pnp_cjs_path.clone();
        let original_pnp_loader = launch.pnp_loader_path.clone();
        let original_artifact = launch.artifact_path.clone();
        let original_media_dir = launch
            .process_env
            .get(COMMON_MEDIA_CACHE_DIR_ENV_KEY)
            .cloned();

        // This represents Admin settings changing after the native prompt opens.
        config.node_bin = temp.path().join("attacker-node");
        config.runtime_dir = temp.path().join("attacker-runtime");
        config.pnp_cjs_path = temp.path().join("attacker-pnp-cjs");
        config.pnp_loader_path = temp.path().join("attacker-pnp-loader");
        config.chain_id = 31337;
        config.process_env.insert(
            COMMON_MEDIA_CACHE_DIR_ENV_KEY.to_owned(),
            temp.path()
                .join("attacker-media")
                .to_string_lossy()
                .into_owned(),
        );

        assert_eq!(launch.node_bin, original_node);
        assert_eq!(launch.runtime_dir, original_runtime_dir);
        assert_eq!(launch.pnp_cjs_path, original_pnp_cjs);
        assert_eq!(launch.pnp_loader_path, original_pnp_loader);
        assert_eq!(launch.artifact_path, original_artifact);
        assert_eq!(launch.chain_id, 1);
        assert_eq!(
            launch.process_env.get(COMMON_MEDIA_CACHE_DIR_ENV_KEY),
            original_media_dir.as_ref()
        );
    }
}
