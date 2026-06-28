use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::app_config::{ensure_desktop_config_paths, load_or_materialize_process_env};
use super::env_keys::{COMMON_MEDIA_CACHE_DIR_ENV_KEY, RPC_ENDPOINT_LIST_ENV_KEY};

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

/// App-data child directory passed as the embedded NATS store root.
pub(crate) const NATS_STORAGE_DIR_NAME: &str = "nats";

/// Directory name Tauri preserves when bundling `src-tauri/resources`.
const TAURI_BUNDLED_RESOURCES_DIR_NAME: &str = "resources";

/// macOS bundle resources directory relative to the executable directory.
const MACOS_BUNDLE_RESOURCES_DIR_NAME: &str = "Resources";

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

        let runtime_dir = resolve_runtime_resources_dir(
            app,
            process_env
                .get("DESKTOP_RUNTIME_RESOURCES_DIR")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("runtime"),
        )?;
        let node_bin = resolve_node_binary_path(
            &runtime_dir,
            process_env.get("DESKTOP_NODE_BIN").map(String::as_str),
        );
        if !node_bin.exists() {
            return Err(format!(
                "Desktop Node binary not found: {} (set DESKTOP_NODE_BIN to override)",
                node_bin.display()
            ));
        }
        let nats_bin = resolve_nats_binary_path(
            &runtime_dir,
            process_env
                .get("DESKTOP_NATS_BINARY_PATH")
                .map(String::as_str),
        );
        if !nats_bin.exists() {
            return Err(format!(
                "Desktop NATS binary not found: {} (set DESKTOP_NATS_BINARY_PATH to override)",
                nats_bin.display()
            ));
        }
        let nats_store_dir = build_nats_store_dir(&app_data_dir)?;
        let pnp_cjs_path = resolve_from_base_dir(
            &runtime_dir,
            process_env
                .get("DESKTOP_NODE_PNP_CJS")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(".pnp.cjs"),
        );
        if !pnp_cjs_path.exists() {
            return Err(format!(
                "DESKTOP_NODE_PNP_CJS does not exist: {}",
                pnp_cjs_path.display()
            ));
        }
        let pnp_loader_path = resolve_from_base_dir(
            &runtime_dir,
            process_env
                .get("DESKTOP_NODE_PNP_LOADER")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(".pnp.loader.mjs"),
        );
        if !pnp_loader_path.exists() {
            return Err(format!(
                "DESKTOP_NODE_PNP_LOADER does not exist: {}",
                pnp_loader_path.display()
            ));
        }
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

fn resolve_runtime_resources_dir(
    app: &AppHandle,
    raw_runtime_subdir: &str,
) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().ok();
    let current_exe = std::env::current_exe().ok();
    let exe_dir = current_exe.as_deref().and_then(Path::parent);
    let candidates = build_runtime_resources_dir_candidates(
        resource_dir.as_deref(),
        exe_dir,
        raw_runtime_subdir,
    );

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.to_path_buf());
        }
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
    raw_runtime_subdir: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(resource_dir) = resource_dir {
        candidates.push(resolve_from_base_dir(resource_dir, raw_runtime_subdir));
        candidates.push(resolve_from_base_dir(
            resource_dir,
            &format!("{TAURI_BUNDLED_RESOURCES_DIR_NAME}/{raw_runtime_subdir}"),
        ));
    }

    if let Some(exe_dir) = exe_dir {
        candidates.push(resolve_from_base_dir(exe_dir, raw_runtime_subdir));
        candidates.push(resolve_from_base_dir(
            exe_dir,
            &format!("{TAURI_BUNDLED_RESOURCES_DIR_NAME}/{raw_runtime_subdir}"),
        ));
        candidates.push(resolve_from_base_dir(
            exe_dir,
            &format!("../{MACOS_BUNDLE_RESOURCES_DIR_NAME}/{raw_runtime_subdir}"),
        ));
    }

    let mut seen = HashSet::<String>::new();
    candidates.retain(|path| seen.insert(path.to_string_lossy().to_string()));
    candidates
}

fn resolve_node_binary_path(runtime_dir: &Path, raw_override: Option<&str>) -> PathBuf {
    let default_relative = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    };
    let raw = raw_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_relative);
    resolve_from_base_dir(runtime_dir, raw)
}

fn resolve_nats_binary_path(runtime_dir: &Path, raw_override: Option<&str>) -> PathBuf {
    let default_relative = if cfg!(windows) {
        "nats/nats-server.exe"
    } else {
        "nats/nats-server"
    };
    let raw = raw_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_relative);
    resolve_from_base_dir(runtime_dir, raw)
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let candidates =
            build_runtime_resources_dir_candidates(Some(resource_dir), Some(exe_dir), "runtime");

        assert!(candidates.contains(&resource_dir.join("resources/runtime")));
        assert!(candidates.contains(&resource_dir.join("runtime")));
        assert!(candidates.contains(&exe_dir.join("runtime")));
    }
}
