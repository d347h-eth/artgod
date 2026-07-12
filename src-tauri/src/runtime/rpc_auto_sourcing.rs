use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::AppHandle;

use super::app_config::ensure_desktop_config_paths;
use super::env_keys::{RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY, RPC_ENDPOINT_LIST_ENV_KEY};
use crate::private_file::write_private_file_atomic;

const EMBEDDED_ETHEREUM_CHAINLIST_RPCS: &str = include_str!("chainlist/ethereum-rpcs.json");
const CHAINLIST_RPCS_SOURCE_URL: &str = "https://chainlist.org/rpcs.json";
const CHAINLIST_RPCS_CACHE_FILE_NAME: &str = "chainlist-rpcs.json";
const CHAINLIST_SOURCE_DESCRIPTION_SAVED: &str = "saved Chainlist file";
const CHAINLIST_SOURCE_DESCRIPTION_EMBEDDED: &str = "embedded Chainlist file";
const CHAINLIST_SOURCE_DESCRIPTION_FRESH: &str = "fresh Chainlist download";
const RPC_ENDPOINT_SOURCE_DESCRIPTION_CONFIGURED: &str = "configured RPC_URL_LIST";
const ETHEREUM_MAINNET_CHAIN_ID: u64 = 1;
const CHAINLIST_RPC_TEMPLATE_MARKER: &str = "${";
const HTTP_RPC_SCHEME: &str = "http";
const HTTPS_RPC_SCHEME: &str = "https";
const HTTPS_RPC_SCHEME_PREFIX: &str = "https://";
const JSON_RPC_HEX_PREFIX: &str = "0x";
const JSON_RPC_METHOD_BLOCK_NUMBER: &str = "eth_blockNumber";
const JSON_RPC_METHOD_GET_LOGS: &str = "eth_getLogs";
const CHAINLIST_TRACKING_VALUE_YES: &str = "yes";
const RPC_AUTO_SOURCE_BENCHMARK_CONCURRENCY: usize = 10;
const RPC_AUTO_SOURCE_BENCHMARK_TIMEOUT_MS: u64 = 1_500;
const RPC_AUTO_SOURCE_CHAINLIST_DOWNLOAD_TIMEOUT_MS: u64 = 30_000;
const RPC_AUTO_SOURCE_LOGS_BACK_BLOCKS: u64 = 10;
const RPC_AUTO_SOURCE_MAX_WEIGHT: u32 = 5;
const RPC_AUTO_SOURCE_WEIGHT_RATIO_HIGH: u128 = 125;
const RPC_AUTO_SOURCE_WEIGHT_RATIO_MEDIUM_HIGH: u128 = 175;
const RPC_AUTO_SOURCE_WEIGHT_RATIO_MEDIUM: u128 = 250;
const RPC_AUTO_SOURCE_WEIGHT_RATIO_LOW: u128 = 400;

/// Chainlist source mode that benchmarks the cached app-data payload or the embedded payload.
pub(crate) const RPC_ENDPOINT_BENCHMARK_SOURCE_SAVED_CHAINLIST: &str = "saved_chainlist";

/// Chainlist source mode that fetches Chainlist over the network, saves it, and benchmarks it.
pub(crate) const RPC_ENDPOINT_BENCHMARK_SOURCE_FRESH_CHAINLIST: &str = "fresh_chainlist";

/// Benchmark source mode that sanity-checks the current configured HTTP RPC endpoint list.
pub(crate) const RPC_ENDPOINT_BENCHMARK_SOURCE_CONFIGURED_ENDPOINTS: &str = "configured_endpoints";

/// Tracking policy that allows only Chainlist endpoints declaring no tracking.
pub(crate) const RPC_AUTO_SOURCING_TRACKING_POLICY_NONE: &str = "none";

/// Tracking policy that allows no-tracking and limited/functional-tracking Chainlist endpoints.
pub(crate) const RPC_AUTO_SOURCING_TRACKING_POLICY_LIMITED: &str = "limited";

/// Tracking policy that allows every concrete Chainlist HTTP endpoint, including tracked ones.
pub(crate) const RPC_AUTO_SOURCING_TRACKING_POLICY_ALL: &str = "all";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEndpointBenchmarkInput {
    pub source: String,
    pub tracking_policy: String,
    #[serde(default)]
    pub rpc_url_list: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEndpointBenchmarkResult {
    pub source: String,
    pub source_description: String,
    pub tracking_policy: String,
    pub encoded_endpoints: String,
    pub endpoints: Vec<RpcEndpointBenchmarkEndpoint>,
    pub candidate_count: usize,
    pub eligible_count: usize,
    pub benchmarked_count: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub tracking_counts: RpcEndpointTrackingCounts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEndpointBenchmarkEndpoint {
    pub url: String,
    pub weight: u32,
    pub latency_ms: u64,
    pub block_number: u64,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcEndpointTrackingCounts {
    pub none: usize,
    pub limited: usize,
    pub yes: usize,
    pub unspecified: usize,
}

#[derive(Clone)]
struct RpcEndpointCandidate {
    url: String,
}

#[derive(Clone)]
struct BenchmarkedRpcEndpoint {
    url: String,
    latency_ms: u64,
    block_number: u64,
}

#[derive(Deserialize)]
struct ChainlistChain {
    #[serde(rename = "chainId")]
    chain_id: u64,
    #[serde(default)]
    rpc: Vec<ChainlistRpcEndpoint>,
}

#[derive(Deserialize)]
struct ChainlistRpcEndpoint {
    url: String,
    tracking: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChainlistTracking {
    None,
    Limited,
    Yes,
    Unspecified,
}

#[derive(Clone, Copy)]
enum TrackingPolicy {
    None,
    Limited,
    All,
}

struct ChainlistCandidateSet {
    candidates: Vec<RpcEndpointCandidate>,
    candidate_count: usize,
    eligible_count: usize,
    tracking_counts: RpcEndpointTrackingCounts,
}

#[derive(Deserialize)]
struct ConfiguredRpcEndpoint {
    url: String,
    weight: Option<Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse<T> {
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

// Benchmarks RPC endpoints for Admin configuration and first-launch automation.
pub async fn benchmark_rpc_endpoints(
    app: &AppHandle,
    input: RpcEndpointBenchmarkInput,
) -> Result<RpcEndpointBenchmarkResult, String> {
    let policy = TrackingPolicy::parse(&input.tracking_policy)?;
    let source = input.source.trim();
    let loaded = match source {
        RPC_ENDPOINT_BENCHMARK_SOURCE_SAVED_CHAINLIST => {
            load_saved_chainlist_candidates(app, policy)?
        }
        RPC_ENDPOINT_BENCHMARK_SOURCE_FRESH_CHAINLIST => {
            load_fresh_chainlist_candidates(app, policy).await?
        }
        RPC_ENDPOINT_BENCHMARK_SOURCE_CONFIGURED_ENDPOINTS => {
            load_configured_rpc_candidates(input.rpc_url_list.as_deref())?
        }
        _ => {
            return Err(format!(
                "Unsupported RPC endpoint benchmark source: {}",
                input.source
            ));
        }
    };

    if loaded.candidates.is_empty() {
        return Err(format!(
            "No eligible RPC endpoints found for {}={}.",
            RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY,
            policy.as_str()
        ));
    }

    let benchmarked = benchmark_candidates(loaded.candidates).await?;
    let benchmarked_count = loaded.eligible_count;
    let success_count = benchmarked.len();
    let failure_count = benchmarked_count.saturating_sub(success_count);

    if benchmarked.is_empty() {
        return Err("No eligible RPC endpoints passed the benchmark.".to_owned());
    }

    let endpoints = build_weighted_benchmark_endpoints(benchmarked);
    let encoded_endpoints = encode_weighted_endpoints(&endpoints)?;

    Ok(RpcEndpointBenchmarkResult {
        source: source.to_owned(),
        source_description: loaded.source_description,
        tracking_policy: policy.as_str().to_owned(),
        encoded_endpoints,
        candidate_count: loaded.candidate_count,
        eligible_count: loaded.eligible_count,
        benchmarked_count,
        success_count,
        failure_count,
        tracking_counts: loaded.tracking_counts,
        endpoints,
    })
}

struct LoadedRpcEndpointCandidates {
    source_description: String,
    candidates: Vec<RpcEndpointCandidate>,
    candidate_count: usize,
    eligible_count: usize,
    tracking_counts: RpcEndpointTrackingCounts,
}

fn load_saved_chainlist_candidates(
    app: &AppHandle,
    policy: TrackingPolicy,
) -> Result<LoadedRpcEndpointCandidates, String> {
    let cache_path = chainlist_cache_file_path(app)?;
    if cache_path.exists() {
        let payload = fs::read_to_string(&cache_path).map_err(|error| {
            format!(
                "Failed to read saved Chainlist RPC file {}: {error}",
                cache_path.display()
            )
        })?;
        return load_saved_chainlist_payload_candidates(&payload, policy);
    }
    load_embedded_chainlist_candidates(policy)
}

fn load_saved_chainlist_payload_candidates(
    payload: &str,
    policy: TrackingPolicy,
) -> Result<LoadedRpcEndpointCandidates, String> {
    match load_chainlist_payload_candidates(CHAINLIST_SOURCE_DESCRIPTION_SAVED, payload, policy) {
        Ok(candidates) => Ok(candidates),
        Err(_) => load_embedded_chainlist_candidates(policy),
    }
}

fn load_embedded_chainlist_candidates(
    policy: TrackingPolicy,
) -> Result<LoadedRpcEndpointCandidates, String> {
    load_chainlist_payload_candidates(
        CHAINLIST_SOURCE_DESCRIPTION_EMBEDDED,
        EMBEDDED_ETHEREUM_CHAINLIST_RPCS,
        policy,
    )
}

fn load_chainlist_payload_candidates(
    source_description: &str,
    payload: &str,
    policy: TrackingPolicy,
) -> Result<LoadedRpcEndpointCandidates, String> {
    let candidate_set = collect_chainlist_candidates(payload, policy)?;
    Ok(LoadedRpcEndpointCandidates {
        source_description: source_description.to_owned(),
        candidates: candidate_set.candidates,
        candidate_count: candidate_set.candidate_count,
        eligible_count: candidate_set.eligible_count,
        tracking_counts: candidate_set.tracking_counts,
    })
}

async fn load_fresh_chainlist_candidates(
    app: &AppHandle,
    policy: TrackingPolicy,
) -> Result<LoadedRpcEndpointCandidates, String> {
    let client = build_chainlist_download_client()?;
    let payload = client
        .get(CHAINLIST_RPCS_SOURCE_URL)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Chainlist RPC file: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Chainlist RPC fetch failed: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Failed to read Chainlist RPC response: {error}"))?;

    let candidate_set = collect_chainlist_candidates(&payload, policy)?;
    let cache_path = chainlist_cache_file_path(app)?;
    write_private_file_atomic(&cache_path, payload.as_bytes()).map_err(|error| {
        format!(
            "Failed to save Chainlist RPC file {}: {error}",
            cache_path.display()
        )
    })?;

    Ok(LoadedRpcEndpointCandidates {
        source_description: CHAINLIST_SOURCE_DESCRIPTION_FRESH.to_owned(),
        candidates: candidate_set.candidates,
        candidate_count: candidate_set.candidate_count,
        eligible_count: candidate_set.eligible_count,
        tracking_counts: candidate_set.tracking_counts,
    })
}

fn load_configured_rpc_candidates(
    raw: Option<&str>,
) -> Result<LoadedRpcEndpointCandidates, String> {
    let value = raw.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return Err(format!("{RPC_ENDPOINT_LIST_ENV_KEY} is empty."));
    }
    let parsed: Vec<ConfiguredRpcEndpoint> = serde_json::from_str(value)
        .map_err(|error| format!("Invalid {RPC_ENDPOINT_LIST_ENV_KEY}: {error}"))?;
    if parsed.is_empty() {
        return Err(format!("{RPC_ENDPOINT_LIST_ENV_KEY} cannot be empty."));
    }

    let mut seen = HashSet::<String>::new();
    let candidates = parsed
        .into_iter()
        .enumerate()
        .map(|(index, endpoint)| validate_configured_endpoint(endpoint, index))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|candidate| seen.insert(candidate.url.clone()))
        .collect::<Vec<_>>();

    Ok(LoadedRpcEndpointCandidates {
        source_description: RPC_ENDPOINT_SOURCE_DESCRIPTION_CONFIGURED.to_owned(),
        candidate_count: candidates.len(),
        eligible_count: candidates.len(),
        tracking_counts: RpcEndpointTrackingCounts::default(),
        candidates,
    })
}

fn validate_configured_endpoint(
    endpoint: ConfiguredRpcEndpoint,
    index: usize,
) -> Result<RpcEndpointCandidate, String> {
    validate_configured_endpoint_weight(endpoint.weight.as_ref(), index)?;
    let url = endpoint.url.trim();
    if url.is_empty() {
        return Err(format!(
            "Invalid {RPC_ENDPOINT_LIST_ENV_KEY}: endpoint {} URL is empty",
            index + 1
        ));
    }
    let parsed = reqwest::Url::parse(url).map_err(|error| {
        format!(
            "Invalid {RPC_ENDPOINT_LIST_ENV_KEY} endpoint {}: {error}",
            index + 1
        )
    })?;
    if !matches!(parsed.scheme(), HTTP_RPC_SCHEME | HTTPS_RPC_SCHEME)
        || parsed.host_str().unwrap_or("").is_empty()
    {
        return Err(format!(
            "Invalid {RPC_ENDPOINT_LIST_ENV_KEY} endpoint {}: URL must use http or https",
            index + 1
        ));
    }
    Ok(RpcEndpointCandidate {
        url: url.to_owned(),
    })
}

fn validate_configured_endpoint_weight(value: Option<&Value>, index: usize) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let valid = match value {
        Value::Number(number) => number.as_u64().is_some_and(|weight| weight > 0),
        Value::String(raw) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .is_some_and(|weight| weight > 0),
        _ => false,
    };
    if valid {
        return Ok(());
    }
    Err(format!(
        "Invalid {RPC_ENDPOINT_LIST_ENV_KEY}: endpoint {} weight must be a positive integer",
        index + 1
    ))
}

fn collect_chainlist_candidates(
    raw: &str,
    policy: TrackingPolicy,
) -> Result<ChainlistCandidateSet, String> {
    let chains: Vec<ChainlistChain> = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse Chainlist RPC JSON: {error}"))?;
    let chain = chains
        .iter()
        .find(|entry| entry.chain_id == ETHEREUM_MAINNET_CHAIN_ID)
        .ok_or_else(|| "Chainlist RPC JSON does not include Ethereum mainnet.".to_owned())?;

    let mut seen = HashSet::<String>::new();
    let mut tracking_counts = RpcEndpointTrackingCounts::default();
    let mut candidates = Vec::<RpcEndpointCandidate>::new();
    let mut candidate_count = 0usize;

    for endpoint in &chain.rpc {
        let url = endpoint.url.trim();
        if !is_concrete_chainlist_http_rpc_url(url) {
            continue;
        }

        let tracking = ChainlistTracking::from_raw(endpoint.tracking.as_deref());
        tracking_counts.add(tracking);
        candidate_count += 1;

        if !policy.allows(tracking) || !seen.insert(url.to_owned()) {
            continue;
        }
        candidates.push(RpcEndpointCandidate {
            url: url.to_owned(),
        });
    }

    Ok(ChainlistCandidateSet {
        eligible_count: candidates.len(),
        candidates,
        candidate_count,
        tracking_counts,
    })
}

fn is_concrete_chainlist_http_rpc_url(url: &str) -> bool {
    url.starts_with(HTTPS_RPC_SCHEME_PREFIX) && !url.contains(CHAINLIST_RPC_TEMPLATE_MARKER)
}

async fn benchmark_candidates(
    candidates: Vec<RpcEndpointCandidate>,
) -> Result<Vec<BenchmarkedRpcEndpoint>, String> {
    let client = build_http_client()?;
    let mut results = stream::iter(candidates.into_iter().map(|candidate| {
        let client = client.clone();
        async move { benchmark_candidate(&client, candidate).await }
    }))
    .buffer_unordered(RPC_AUTO_SOURCE_BENCHMARK_CONCURRENCY)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .filter_map(Result::ok)
    .collect::<Vec<_>>();

    results.sort_by(|left, right| {
        left.latency_ms
            .cmp(&right.latency_ms)
            .then_with(|| left.url.cmp(&right.url))
    });
    Ok(results)
}

async fn benchmark_candidate(
    client: &Client,
    candidate: RpcEndpointCandidate,
) -> Result<BenchmarkedRpcEndpoint, String> {
    let block_hex: String = send_json_rpc(
        client,
        &candidate.url,
        JSON_RPC_METHOD_BLOCK_NUMBER,
        json!([]),
    )
    .await
    .map_err(|error| {
        format!(
            "{} {JSON_RPC_METHOD_BLOCK_NUMBER} failed: {error}",
            candidate.url
        )
    })?;
    let block_number = parse_json_rpc_hex_u64(&block_hex)?;
    let logs_block = block_number.saturating_sub(RPC_AUTO_SOURCE_LOGS_BACK_BLOCKS);
    let logs_block_hex = format_json_rpc_hex_u64(logs_block);

    let started_at = Instant::now();
    let _: Value = send_json_rpc(
        client,
        &candidate.url,
        JSON_RPC_METHOD_GET_LOGS,
        json!([{ "fromBlock": logs_block_hex, "toBlock": logs_block_hex }]),
    )
    .await
    .map_err(|error| {
        format!(
            "{} {JSON_RPC_METHOD_GET_LOGS} failed: {error}",
            candidate.url
        )
    })?;

    Ok(BenchmarkedRpcEndpoint {
        url: candidate.url,
        latency_ms: duration_millis(started_at.elapsed()),
        block_number,
    })
}

async fn send_json_rpc<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: &str,
    method: &str,
    params: Value,
) -> Result<T, String> {
    let response = client
        .post(url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let payload = response
        .json::<JsonRpcResponse<T>>()
        .await
        .map_err(|error| error.to_string())?;

    if let Some(error) = payload.error {
        return Err(format!("JSON-RPC error {}: {}", error.code, error.message));
    }
    payload
        .result
        .ok_or_else(|| "JSON-RPC response did not include a result".to_owned())
}

fn build_weighted_benchmark_endpoints(
    endpoints: Vec<BenchmarkedRpcEndpoint>,
) -> Vec<RpcEndpointBenchmarkEndpoint> {
    let fastest_latency = endpoints
        .first()
        .map(|endpoint| endpoint.latency_ms.max(1))
        .unwrap_or(1);
    endpoints
        .into_iter()
        .map(|endpoint| RpcEndpointBenchmarkEndpoint {
            weight: weight_for_latency(endpoint.latency_ms.max(1), fastest_latency),
            url: endpoint.url,
            latency_ms: endpoint.latency_ms,
            block_number: endpoint.block_number,
        })
        .collect()
}

fn encode_weighted_endpoints(endpoints: &[RpcEndpointBenchmarkEndpoint]) -> Result<String, String> {
    let entries = endpoints
        .iter()
        .map(|endpoint| {
            json!({
                "url": endpoint.url,
                "weight": endpoint.weight
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&entries)
        .map_err(|error| format!("Failed to encode RPC endpoint list: {error}"))
}

fn weight_for_latency(latency_ms: u64, fastest_latency_ms: u64) -> u32 {
    let ratio_percent = (u128::from(latency_ms) * 100u128) / u128::from(fastest_latency_ms.max(1));
    if ratio_percent <= RPC_AUTO_SOURCE_WEIGHT_RATIO_HIGH {
        RPC_AUTO_SOURCE_MAX_WEIGHT
    } else if ratio_percent <= RPC_AUTO_SOURCE_WEIGHT_RATIO_MEDIUM_HIGH {
        4
    } else if ratio_percent <= RPC_AUTO_SOURCE_WEIGHT_RATIO_MEDIUM {
        3
    } else if ratio_percent <= RPC_AUTO_SOURCE_WEIGHT_RATIO_LOW {
        2
    } else {
        1
    }
}

fn parse_json_rpc_hex_u64(raw: &str) -> Result<u64, String> {
    let Some(hex) = raw.trim().strip_prefix(JSON_RPC_HEX_PREFIX) else {
        return Err(format!("Invalid JSON-RPC hex quantity: {raw}"));
    };
    u64::from_str_radix(hex, 16).map_err(|error| format!("Invalid JSON-RPC hex quantity: {error}"))
}

fn format_json_rpc_hex_u64(value: u64) -> String {
    format!("{JSON_RPC_HEX_PREFIX}{value:x}")
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn build_http_client() -> Result<Client, String> {
    build_timeout_http_client(
        RPC_AUTO_SOURCE_BENCHMARK_TIMEOUT_MS,
        "RPC benchmark HTTP client",
    )
}

fn build_chainlist_download_client() -> Result<Client, String> {
    build_timeout_http_client(
        RPC_AUTO_SOURCE_CHAINLIST_DOWNLOAD_TIMEOUT_MS,
        "Chainlist download HTTP client",
    )
}

fn build_timeout_http_client(timeout_ms: u64, label: &str) -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| format!("Failed to create {label}: {error}"))
}

fn chainlist_cache_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let paths = ensure_desktop_config_paths(app)?;
    let config_dir = paths
        .settings_file_path
        .parent()
        .ok_or_else(|| "Desktop settings path has no parent directory.".to_owned())?;
    Ok(config_dir.join(CHAINLIST_RPCS_CACHE_FILE_NAME))
}

impl ChainlistTracking {
    fn from_raw(raw: Option<&str>) -> Self {
        match raw
            .map(str::trim)
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            RPC_AUTO_SOURCING_TRACKING_POLICY_NONE => Self::None,
            RPC_AUTO_SOURCING_TRACKING_POLICY_LIMITED => Self::Limited,
            CHAINLIST_TRACKING_VALUE_YES => Self::Yes,
            _ => Self::Unspecified,
        }
    }
}

impl RpcEndpointTrackingCounts {
    fn add(&mut self, tracking: ChainlistTracking) {
        match tracking {
            ChainlistTracking::None => self.none += 1,
            ChainlistTracking::Limited => self.limited += 1,
            ChainlistTracking::Yes => self.yes += 1,
            ChainlistTracking::Unspecified => self.unspecified += 1,
        }
    }
}

impl TrackingPolicy {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            RPC_AUTO_SOURCING_TRACKING_POLICY_NONE => Ok(Self::None),
            RPC_AUTO_SOURCING_TRACKING_POLICY_LIMITED => Ok(Self::Limited),
            RPC_AUTO_SOURCING_TRACKING_POLICY_ALL => Ok(Self::All),
            _ => Err(format!(
                "Invalid {}: {}",
                RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY, raw
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::None => RPC_AUTO_SOURCING_TRACKING_POLICY_NONE,
            Self::Limited => RPC_AUTO_SOURCING_TRACKING_POLICY_LIMITED,
            Self::All => RPC_AUTO_SOURCING_TRACKING_POLICY_ALL,
        }
    }

    fn allows(self, tracking: ChainlistTracking) -> bool {
        match self {
            Self::None => tracking == ChainlistTracking::None,
            Self::Limited => {
                matches!(
                    tracking,
                    ChainlistTracking::None | ChainlistTracking::Limited
                )
            }
            Self::All => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CHAINLIST: &str = r#"[
        {
            "chainId": 1,
            "rpc": [
                { "url": "https://none.example", "tracking": "none" },
                { "url": "https://limited.example", "tracking": "limited" },
                { "url": "https://yes.example", "tracking": "yes" },
                { "url": "https://unspecified.example" },
                { "url": "wss://none-ws.example", "tracking": "none" },
                { "url": "https://${API_KEY}.example", "tracking": "none" }
            ]
        }
    ]"#;

    #[test]
    fn chainlist_filter_defaults_to_no_tracking_https_endpoints() {
        let candidates =
            collect_chainlist_candidates(SAMPLE_CHAINLIST, TrackingPolicy::None).unwrap();

        assert_eq!(candidates.candidates.len(), 1);
        assert_eq!(candidates.candidates[0].url, "https://none.example");
        assert_eq!(candidates.candidate_count, 4);
        assert_eq!(candidates.tracking_counts.none, 1);
        assert_eq!(candidates.tracking_counts.unspecified, 1);
    }

    #[test]
    fn chainlist_filter_can_include_limited_or_all_tracking_endpoints() {
        let limited =
            collect_chainlist_candidates(SAMPLE_CHAINLIST, TrackingPolicy::Limited).unwrap();
        let all = collect_chainlist_candidates(SAMPLE_CHAINLIST, TrackingPolicy::All).unwrap();

        assert_eq!(limited.eligible_count, 2);
        assert_eq!(all.eligible_count, 4);
    }

    #[test]
    fn latency_weights_scale_from_fastest_endpoint() {
        assert_eq!(weight_for_latency(100, 100), 5);
        assert_eq!(weight_for_latency(150, 100), 4);
        assert_eq!(weight_for_latency(225, 100), 3);
        assert_eq!(weight_for_latency(350, 100), 2);
        assert_eq!(weight_for_latency(450, 100), 1);
    }

    #[test]
    fn endpoint_weighting_preserves_every_successful_benchmark() {
        let successes = (0..12)
            .map(|index| BenchmarkedRpcEndpoint {
                url: format!("https://rpc-{index}.example"),
                latency_ms: 100 + index,
                block_number: 1,
            })
            .collect::<Vec<_>>();

        let weighted = build_weighted_benchmark_endpoints(successes);

        assert_eq!(weighted.len(), 12);
    }

    #[test]
    fn chainlist_download_timeout_is_separate_from_rpc_probe_timeout() {
        assert!(
            RPC_AUTO_SOURCE_CHAINLIST_DOWNLOAD_TIMEOUT_MS > RPC_AUTO_SOURCE_BENCHMARK_TIMEOUT_MS
        );
    }

    #[test]
    fn saved_chainlist_payload_falls_back_to_embedded_when_invalid() {
        let candidates =
            load_saved_chainlist_payload_candidates("{", TrackingPolicy::None).unwrap();

        assert_eq!(
            candidates.source_description,
            CHAINLIST_SOURCE_DESCRIPTION_EMBEDDED
        );
        assert!(candidates.eligible_count > 0);
    }

    #[test]
    fn configured_endpoint_validation_rejects_invalid_weights() {
        let error = match load_configured_rpc_candidates(Some(
            r#"[{"url":"https://rpc.example","weight":0}]"#,
        )) {
            Ok(_) => panic!("invalid weight should fail"),
            Err(error) => error,
        };

        assert!(error.contains("weight must be a positive integer"));
    }

    #[test]
    fn embedded_chainlist_has_no_tracking_ethereum_http_candidates() {
        let candidates =
            collect_chainlist_candidates(EMBEDDED_ETHEREUM_CHAINLIST_RPCS, TrackingPolicy::None)
                .unwrap();

        assert!(candidates.eligible_count > 0);
        assert!(candidates.tracking_counts.none > 0);
    }
}
