// Env key for the primary weighted HTTP JSON-RPC endpoint list.
pub(crate) const RPC_ENDPOINT_LIST_ENV_KEY: &str = "RPC_URL_LIST";

// Env key for the Admin-only Chainlist privacy policy used by RPC auto-sourcing.
pub(crate) const RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY: &str =
    "RPC_AUTO_SOURCING_TRACKING_POLICY";

// Env key for the optional weighted WebSocket JSON-RPC endpoint list.
#[cfg(test)]
pub(crate) const RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY: &str = "RPC_WS_URL_LIST";
