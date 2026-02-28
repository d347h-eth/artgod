use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub struct DesktopRuntimeConfig {
    pub env_file_path: PathBuf,
    pub node_bin: PathBuf,
    pub nats_bin: PathBuf,
    pub runtime_dir: PathBuf,
    pub pnp_cjs_path: PathBuf,
    pub pnp_loader_path: PathBuf,
    pub nats_port: u16,
    pub backend_port: u16,
    pub auto_start: bool,
    pub restart_backoff_ms: u64,
    pub process_env: HashMap<String, String>,
    pub logs_dir: PathBuf,
}

impl DesktopRuntimeConfig {
    pub fn load_or_create(app: &AppHandle) -> Result<Self, String> {
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
        fs::create_dir_all(&logs_dir).map_err(|error| {
            format!("Failed to create logs dir {}: {error}", logs_dir.display())
        })?;

        let env_file_path = config_dir.join(".env");
        if !env_file_path.exists() {
            let template = build_default_env_template();
            fs::write(&env_file_path, template).map_err(|error| {
                format!(
                    "Failed to create desktop env file {}: {error}",
                    env_file_path.display()
                )
            })?;
        }

        let process_env = parse_env_file(&env_file_path)?;

        let runtime_dir = resolve_runtime_resources_dir(
            app,
            process_env
                .get("DESKTOP_RUNTIME_RESOURCES_DIR")
                .map(String::as_str)
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
        let pnp_cjs_path = resolve_from_base_dir(
            &runtime_dir,
            process_env
                .get("DESKTOP_NODE_PNP_CJS")
                .map(String::as_str)
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
                .unwrap_or(".pnp.loader.mjs"),
        );
        if !pnp_loader_path.exists() {
            return Err(format!(
                "DESKTOP_NODE_PNP_LOADER does not exist: {}",
                pnp_loader_path.display()
            ));
        }
        let nats_port = parse_port(get_required(&process_env, "DESKTOP_NATS_PORT")?)?;
        let backend_port = parse_port(get_required(&process_env, "BACKEND_PORT")?)?;
        let auto_start = parse_bool(get_required(&process_env, "DESKTOP_AUTO_START")?)?;
        let restart_backoff_ms =
            parse_u64(get_required(&process_env, "DESKTOP_RESTART_BACKOFF_MS")?)?;

        // Core runtime env is required for backend/indexer startup.
        get_required(&process_env, "ARTGOD_DB_PATH")?;
        get_required(&process_env, "RPC_URL")?;
        get_required(&process_env, "WETH_ADDRESS")?;
        get_required(&process_env, "SEAPORT_CONDUIT_CONTROLLER")?;

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
        merged_env.insert(
            "NATS_URL".to_owned(),
            format!("nats://127.0.0.1:{nats_port}"),
        );
        merged_env.insert("BACKEND_PORT".to_owned(), backend_port.to_string());

        Ok(Self {
            env_file_path,
            node_bin,
            nats_bin,
            runtime_dir,
            pnp_cjs_path,
            pnp_loader_path,
            nats_port,
            backend_port,
            auto_start,
            restart_backoff_ms,
            process_env: merged_env,
            logs_dir,
        })
    }

    pub fn backend_http_base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.backend_port)
    }

    pub fn nats_url(&self) -> String {
        format!("nats://127.0.0.1:{}", self.nats_port)
    }
}

fn parse_env_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read desktop env file {}: {error}",
            path.display()
        )
    })?;
    let mut values = HashMap::<String, String>::new();

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
        let mut value = raw_value.trim().to_owned();
        if let Some((without_prefix, true)) = value
            .strip_prefix('"')
            .map(|value| (value, value.ends_with('"')))
        {
            value = without_prefix
                .strip_suffix('"')
                .unwrap_or(without_prefix)
                .to_owned();
        } else if let Some((without_prefix, true)) = value
            .strip_prefix('\'')
            .map(|value| (value, value.ends_with('\'')))
        {
            value = without_prefix
                .strip_suffix('\'')
                .unwrap_or(without_prefix)
                .to_owned();
        }
        values.insert(key.to_owned(), value);
    }

    Ok(values)
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
    let mut candidates = Vec::<PathBuf>::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resolve_from_base_dir(&resource_dir, raw_runtime_subdir));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(resolve_from_base_dir(exe_dir, raw_runtime_subdir));
            candidates.push(resolve_from_base_dir(
                exe_dir,
                &format!("resources/{raw_runtime_subdir}"),
            ));
            candidates.push(resolve_from_base_dir(
                exe_dir,
                &format!("../Resources/{raw_runtime_subdir}"),
            ));
        }
    }

    let mut seen = HashSet::<String>::new();
    candidates.retain(|path| seen.insert(path.to_string_lossy().to_string()));

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

fn build_default_env_template() -> String {
    format!(concat!(
        "# ArtGod desktop runtime env\n",
        "# Generated on first start. This file is the single config source for\n",
        "# desktop-managed backend/indexer processes.\n\n",
        "# Optional: override bundled Node binary path (absolute or relative to runtime resources dir)\n",
        "# DESKTOP_NODE_BIN=node/node(.exe)\n",
        "DESKTOP_RUNTIME_RESOURCES_DIR=runtime\n",
        "DESKTOP_AUTO_START=true\n",
        "DESKTOP_RESTART_BACKOFF_MS=1500\n\n",
        "# Optional: override bundled NATS binary path (absolute or relative to runtime resources dir)\n",
        "# DESKTOP_NATS_BINARY_PATH=nats/nats-server(.exe)\n",
        "DESKTOP_NATS_PORT=4222\n",
        "\n",
        "# Backend\n",
        "BACKEND_PORT=3000\n\n",
        "# Indexer core runtime\n",
        "# ARTGOD_DB_PATH is resolved relative to app-data dir unless absolute\n",
        "ARTGOD_DB_PATH=sqlite/main/db\n",
        "CHAIN_ID=1\n",
        "RPC_URL=http://127.0.0.1:8545\n",
        "WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2\n",
        "SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63\n",
        "NATS_STREAM_PREFIX=artgod\n",
        "OPENSEA_STREAM_MODE=fixtures\n",
        "# OPENSEA_FIXTURES_DIR is resolved relative to desktop runtime resources dir unless absolute\n",
        "OPENSEA_FIXTURES_DIR=fixtures/opensea-event-payloads\n",
        "OPENSEA_FIXTURE_DELAY_MS=0\n",
        "METRICS_ENABLED=false\n",
        "APM_ENABLED=false\n",
        "METADATA_REFRESH_RANGE_CHUNK_SIZE=200\n",
        "BOOTSTRAP_SNAPSHOT_BATCH_SIZE=200\n",
        "BOOTSTRAP_METADATA_BATCH_SIZE=200\n",
        "BOOTSTRAP_METADATA_CONCURRENCY=8\n",
        "BOOTSTRAP_METADATA_PROCESS_POLL_MS=5000\n",
        "REORG_DEPTH=32\n",
        "BACKFILL_BATCH_SIZE=50\n",
        "LOG_CHUNK_SIZE=2000\n"
    ),)
}
