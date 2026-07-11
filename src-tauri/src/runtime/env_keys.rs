// Env key for the primary weighted HTTP JSON-RPC endpoint list.
pub(crate) const RPC_ENDPOINT_LIST_ENV_KEY: &str = "RPC_URL_LIST";

// Env key for the Admin-only Chainlist privacy policy used by RPC auto-sourcing.
pub(crate) const RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY: &str =
    "RPC_AUTO_SOURCING_TRACKING_POLICY";

// Env key for the optional local media-cache directory shared by runtime children.
pub(crate) const COMMON_MEDIA_CACHE_DIR_ENV_KEY: &str = "COMMON_MEDIA_CACHE_DIR";

/// Env key for the bidding runtime's live-versus-dry-run policy.
pub(crate) const BIDDING_DRY_RUN_ENV_KEY: &str = "BIDDING_DRY_RUN";

/// Env key for the exact OpenSea conduit WETH allowance cap.
pub(crate) const BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY: &str = "BIDDING_WETH_ALLOWANCE_ETH";

/// Env key for explicit OpenSea SignedZone trait-offer trust.
pub(crate) const BIDDING_TRAIT_OFFERS_ENABLED_ENV_KEY: &str =
    "BIDDING_TRUST_OPENSEA_SIGNED_ZONE_FOR_TRAIT_OFFERS";

// Env key for the optional weighted WebSocket JSON-RPC endpoint list.
#[cfg(test)]
pub(crate) const RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY: &str = "RPC_WS_URL_LIST";
