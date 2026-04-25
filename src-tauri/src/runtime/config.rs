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
    pub nats_host: String,
    pub nats_port: u16,
    pub nats_url: String,
    pub backend_port: u16,
    pub chain_id: u64,
    pub auto_start: bool,
    pub restart_backoff_ms: u64,
    pub process_env: HashMap<String, String>,
    pub logs_dir: PathBuf,
    #[allow(dead_code)]
    pub wallet: DesktopWalletConfig,
}

#[derive(Clone, Debug)]
pub struct DesktopWalletConfig {
    pub store_dir: PathBuf,
    pub index_path: PathBuf,
    #[allow(dead_code)]
    pub bot_unlock_stabilization_delay_ms: u64,
}

struct DesktopLocalPaths {
    app_data_dir: PathBuf,
    logs_dir: PathBuf,
    env_file_path: PathBuf,
}

impl DesktopWalletConfig {
    pub fn load_or_create(app: &AppHandle) -> Result<Self, String> {
        let local_paths = ensure_desktop_local_paths(app)?;
        let process_env = parse_env_file(&local_paths.env_file_path)?;
        build_wallet_config(&local_paths.app_data_dir, &process_env)
    }
}

impl DesktopRuntimeConfig {
    pub fn load_or_create(app: &AppHandle) -> Result<Self, String> {
        let local_paths = ensure_desktop_local_paths(app)?;
        let app_data_dir = local_paths.app_data_dir.clone();
        let env_file_path = local_paths.env_file_path.clone();
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
        let backend_port = parse_port(get_required(&process_env, "BACKEND_PORT")?)?;
        let chain_id = parse_u64(get_required(&process_env, "CHAIN_ID")?)?;
        let auto_start = parse_bool(get_required(&process_env, "DESKTOP_AUTO_START")?)?;
        let restart_backoff_ms =
            parse_u64(get_required(&process_env, "DESKTOP_RESTART_BACKOFF_MS")?)?;
        let wallet = build_wallet_config(&app_data_dir, &process_env)?;

        // Core runtime env is required for backend/indexer startup.
        get_required(&process_env, "ARTGOD_DB_PATH")?;
        let nats_url = get_required(&process_env, "NATS_URL")?.to_owned();
        let (nats_host, nats_port) = parse_nats_url(&nats_url)?;
        get_required(&process_env, "RPC_URL")?;
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
        merged_env.insert(
            "USERLAND_UI_DIST_DIR".to_owned(),
            userland_ui_dist_dir.to_string_lossy().into_owned(),
        );
        merged_env.insert("BACKEND_PORT".to_owned(), backend_port.to_string());

        Ok(Self {
            env_file_path,
            node_bin,
            nats_bin,
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

fn ensure_desktop_local_paths(app: &AppHandle) -> Result<DesktopLocalPaths, String> {
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

    Ok(DesktopLocalPaths {
        app_data_dir,
        logs_dir,
        env_file_path,
    })
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
            .unwrap_or("wallets"),
    );
    fs::create_dir_all(&wallet_store_dir).map_err(|error| {
        format!(
            "Failed to create wallet store dir {}: {error}",
            wallet_store_dir.display()
        )
    })?;
    let bot_unlock_stabilization_delay_ms = parse_u64(get_required(
        process_env,
        "DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS",
    )?)?;

    Ok(DesktopWalletConfig {
        store_dir: wallet_store_dir.clone(),
        index_path: wallet_store_dir.join("index.json"),
        bot_unlock_stabilization_delay_ms,
    })
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
    let mut candidates = Vec::<PathBuf>::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resolve_from_base_dir(&resource_dir, raw_runtime_subdir));
    }

    if let Ok(current_exe) = std::env::current_exe()
        && let Some(exe_dir) = current_exe.parent()
    {
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
    concat!(
        "# ArtGod desktop runtime env\n",
        "# Generated on first start. This file is the single config source for\n",
        "# desktop-managed backend/indexer processes.\n\n",
        "# Optional: override bundled Node binary path (absolute or relative to runtime resources dir)\n",
        "# DESKTOP_NODE_BIN=node/node(.exe)\n",
        "DESKTOP_RUNTIME_RESOURCES_DIR=runtime\n",
        "DESKTOP_AUTO_START=true\n",
        "DESKTOP_RESTART_BACKOFF_MS=1500\n\n",
        "# Wallet store directory is resolved relative to app-data dir unless absolute\n",
        "DESKTOP_WALLET_STORE_DIR=wallets\n",
        "DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS=5000\n\n",
        "# Optional: override bundled NATS binary path (absolute or relative to runtime resources dir)\n",
        "# DESKTOP_NATS_BINARY_PATH=nats/nats-server(.exe)\n",
        "\n",
        "# Backend\n",
        "BACKEND_HOST=127.0.0.1\n",
        "BACKEND_PORT=3000\n\n",
        "# Indexer core runtime\n",
        "# ARTGOD_DB_PATH is resolved relative to app-data dir unless absolute\n",
        "ARTGOD_DB_PATH=sqlite/main/db\n",
        "# USERLAND_UI_DIST_DIR is resolved relative to desktop runtime resources dir unless absolute\n",
        "USERLAND_UI_DIST_DIR=frontend/userland\n",
        "CHAIN_ID=1\n",
        "RPC_URL=http://127.0.0.1:8545\n",
        "RPC_RETRY_MAX_ATTEMPTS=5\n",
        "RPC_RETRY_BASE_DELAY_MS=100\n",
        "RPC_RETRY_MAX_DELAY_MS=3000\n",
        "RPC_RATE_LIMIT_REQUESTS_PER_SECOND=50\n",
        "RPC_RATE_LIMIT_BURST=100\n",
        "RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5\n",
        "RPC_CIRCUIT_BREAKER_OPEN_MS=5000\n",
        "RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS=2\n",
        "CACHE_MAX_ENTRIES=5000\n",
        "CACHE_TTL_MS=30000\n",
        "NATS_URL=nats://127.0.0.1:4222\n",
        "WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2\n",
        "SEAPORT_CONDUIT_CONTROLLER=0x00000000f9490004c11cef243f5400493c00ad63\n",
        "BACKEND_ALLOWED_HOSTS=127.0.0.1,localhost,::1\n",
        "BACKEND_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173,http://tauri.localhost,tauri://localhost\n",
        "BACKEND_CSRF_COOKIE_SECURE=false\n",
        "PUBLIC_BACKEND_ORIGIN=http://127.0.0.1:3000\n",
        "NATS_STREAM_PREFIX=artgod\n",
        "OPENSEA_API_KEY=\n",
        "OPENSEA_SNAPSHOT_PAGE_SIZE=100\n",
        "OPENSEA_RECONCILE_INTERVAL_MS=900000\n",
        "OPENSEA_STALE_START_THRESHOLD_MS=1800000\n",
        "OPENSEA_STREAM_SUBSCRIPTION_POLL_MS=5000\n",
        "OPENSEA_HTTP_RETRY_MAX_ATTEMPTS=3\n",
        "OPENSEA_HTTP_RETRY_BASE_DELAY_MS=500\n",
        "OPENSEA_HTTP_RETRY_MAX_DELAY_MS=10000\n",
        "OPENSEA_HTTP_RETRY_JITTER_RATIO=0.2\n",
        "OPENSEA_RATE_LIMIT_GET_MAX=4\n",
        "OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND=2\n",
        "OPENSEA_RATE_LIMIT_POST_MAX=2\n",
        "OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND=1\n",
        "\n",
        "# Trading runtime\n",
        "# Keep bot lanes separate from the indexer OPENSEA_API_KEY.\n",
        "OPENSEA_STREAM_SECRET_KEY=\n",
        "OPENSEA_BIDDING_SECRET_KEY=\n",
        "OPENSEA_SNAPSHOT_SECRET_KEY=\n",
        "\n",
        "BIDDING_ENABLED=true\n",
        "BIDDING_DRY_RUN=false\n",
        "# Static startup WETH approval target for OpenSea bidding, in Ether units. Use 0 to skip startup approval.\n",
        "BIDDING_WETH_ALLOWANCE_ETH=0\n",
        "# Bidding bot EIP-1559 fee policy. Gwei values are human-readable; the min tip is used when the node reports 0.\n",
        "BIDDING_TX_MIN_PRIORITY_FEE_GWEI=0.1\n",
        "BIDDING_TX_FEE_HISTORY_BLOCKS=20\n",
        "BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE=70\n",
        "BIDDING_TX_BASE_FEE_MULTIPLIER=1.25\n",
        "BIDDING_TX_MAX_FEE_GWEI=10\n",
        "BIDDING_TX_PENDING_NONCE_POLICY=fail\n",
        "BIDDING_POLL_MS=300000\n",
        "BIDDING_MAX_CONCURRENT_JOBS=1\n",
        "BIDDING_BOOTSTRAP_CONCURRENCY=3\n",
        "BIDDING_OFFER_EXPIRATION_SECONDS=86400\n",
        "BIDDING_COLLECTION_OFFERS_POLL_MS=60000\n",
        "BIDDING_COLLECTION_OFFERS_TTL_MS=15000\n",
        "BIDDING_ORDER_LOOKUP_MAX_PAGES=5\n",
        "BIDDING_COMMAND_POLL_MS=1000\n",
        "BIDDING_COMMAND_BATCH_SIZE=20\n",
        "BIDDING_COMMAND_MAX_ATTEMPTS=5\n",
        "BIDDING_COMMAND_CLAIM_TIMEOUT_MS=300000\n",
        "BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION={\"terraforms\":[\"Zone\",\"Biome\",\"Level\"]}\n",
        "BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION={\"terraforms\":[\"Zone\",\"Biome\",\"Level\",\"Mode\"]}\n",
        "METRICS_ENABLED=false\n",
        "APM_ENABLED=false\n",
        "METADATA_REFRESH_RANGE_CHUNK_SIZE=200\n",
        "BOOTSTRAP_SNAPSHOT_BATCH_SIZE=200\n",
        "BOOTSTRAP_METADATA_BATCH_SIZE=200\n",
        "BOOTSTRAP_METADATA_CONCURRENCY=8\n",
        "BOOTSTRAP_METADATA_PROCESS_POLL_MS=5000\n",
        "BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS=5\n",
        "BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS=100\n",
        "BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS=3000\n",
        "REORG_DEPTH=32\n",
        "BACKFILL_BATCH_SIZE=50\n",
        "LOG_CHUNK_SIZE=2000\n"
    )
    .to_string()
}
