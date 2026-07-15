// Generated from config/settings-validation-rules.json.
// Do not edit directly; run `yarn config:generate`.

// Validation rule names shared by the manifest generator and Admin clients.
export const SETTINGS_VALIDATION_RULE = {
    Url: "url",
    PositiveInteger: "positive_integer",
    TcpPort: "tcp_port",
    RpcEndpointList: "rpc_endpoint_list",
    WebSocketEndpointList: "websocket_endpoint_list",
    BlockExplorerBaseUrl: "block_explorer_base_url",
    BlockExplorerTransactionPathTemplate: "block_explorer_tx_path_template",
    BlockExplorerAddressPathTemplate: "block_explorer_address_path_template",
    BlockExplorerBlockPathTemplate: "block_explorer_block_path_template",
} as const;

// Exact validation vocabulary accepted by generated settings clients.
export type SettingsValidationRule =
    (typeof SETTINGS_VALIDATION_RULE)[keyof typeof SETTINGS_VALIDATION_RULE];
