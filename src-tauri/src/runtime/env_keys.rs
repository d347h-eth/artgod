// Env key for the primary weighted HTTP JSON-RPC endpoint list.
pub(crate) const RPC_ENDPOINT_LIST_ENV_KEY: &str = "RPC_URL_LIST";

// Env key for the Admin-only Chainlist privacy policy used by RPC auto-sourcing.
pub(crate) const RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY: &str =
    "RPC_AUTO_SOURCING_TRACKING_POLICY";

// Env key for the optional local media-cache directory shared by runtime children.
pub(crate) const COMMON_MEDIA_CACHE_DIR_ENV_KEY: &str = "COMMON_MEDIA_CACHE_DIR";

// Env key for the per-attempt timeout shared by ordinary HTTP fetches.
pub(crate) const COMMON_HTTP_FETCH_TIMEOUT_MS_ENV_KEY: &str = "COMMON_HTTP_FETCH_TIMEOUT_MS";

// Env key for the total attempt limit shared by ordinary HTTP fetches.
pub(crate) const COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS_ENV_KEY: &str =
    "COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS";

// Env key for the initial retry delay shared by ordinary HTTP fetches.
pub(crate) const COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS_ENV_KEY: &str =
    "COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS";

// Env key for the maximum retry delay shared by ordinary HTTP fetches.
pub(crate) const COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS_ENV_KEY: &str =
    "COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS";

/// Env key for the exact OpenSea conduit WETH allowance cap.
pub(crate) const BIDDING_WETH_ALLOWANCE_CAP_ENV_KEY: &str = "BIDDING_WETH_ALLOWANCE_ETH";

/// Env key for explicit OpenSea SignedZone trait-offer trust.
pub(crate) const BIDDING_TRAIT_OFFERS_ENABLED_ENV_KEY: &str =
    "BIDDING_TRUST_OPENSEA_SIGNED_ZONE_FOR_TRAIT_OFFERS";

/// Env key for the minimum EIP-1559 priority fee selected for WETH approval.
pub(crate) const BIDDING_TX_MIN_PRIORITY_FEE_ENV_KEY: &str = "BIDDING_TX_MIN_PRIORITY_FEE_GWEI";

/// Env key for the maximum fee per gas selected for WETH approval.
pub(crate) const BIDDING_TX_MAX_FEE_ENV_KEY: &str = "BIDDING_TX_MAX_FEE_GWEI";

/// Env key for the maximum total network fee of one WETH approval transaction.
pub(crate) const BIDDING_WETH_APPROVAL_MAX_GAS_FEE_ENV_KEY: &str =
    "BIDDING_WETH_APPROVAL_MAX_GAS_FEE_ETH";

/// Env key for the fail-only pending transaction policy.
pub(crate) const BIDDING_TX_PENDING_NONCE_POLICY_ENV_KEY: &str = "BIDDING_TX_PENDING_NONCE_POLICY";

// Env key for the optional weighted WebSocket JSON-RPC endpoint list.
#[cfg(test)]
pub(crate) const RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY: &str = "RPC_WS_URL_LIST";
