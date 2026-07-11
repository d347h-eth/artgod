mod app_config;
mod app_config_manifest;
mod backend_collection_catalog;
mod bidding_mandate;
mod bot_runtime;
mod config;
mod env_keys;
mod log_files;
mod private_file;
mod process_registry;
mod resource_contract;
mod rpc_auto_sourcing;
mod runtime_integrity;
mod supervisor;

pub use app_config::{
    AppConfigState, SaveAppConfigInput, ensure_desktop_config_paths, load_app_config_state,
    load_effective_app_config_values, save_app_config, use_default_app_config,
};
pub use backend_collection_catalog::{
    BackendCollectionCatalog, BiddingChainIdentity, BiddingCollectionCandidate,
    BiddingCollectionCatalog,
};
pub use bidding_mandate::{
    BiddingCollectionMandate, BiddingCollectionMandateDraft, BiddingCollectionTokenScopeSummary,
    BiddingMandate, BiddingMandateDraft, BiddingStartPolicySnapshot, format_wei_as_eth,
};
pub use bot_runtime::{
    BotCriticalDependencyStatus, BotRuntimeSnapshot, BotRuntimeState, bot_runtime_spec,
    build_trading_secret_envelope,
};
pub use config::{DesktopRuntimeConfig, DesktopWalletConfig};
pub(crate) use env_keys::RPC_ENDPOINT_LIST_ENV_KEY;
pub(crate) use log_files::ensure_runtime_log_files;
pub use rpc_auto_sourcing::{
    RpcEndpointBenchmarkInput, RpcEndpointBenchmarkResult, benchmark_rpc_endpoints,
};
pub use supervisor::{RuntimeEndpoints, RuntimeManager, RuntimeStatus};
