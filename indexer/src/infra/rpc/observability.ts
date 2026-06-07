// Component labels that split indexer RPC metrics by runtime use case.
export const INDEXER_RPC_OBSERVABILITY_COMPONENT = {
    DefaultHttp: "http-rpc",
    PrimaryHttp: "primary-http-rpc",
    BackfillHttp: "backfill-http-rpc",
    SchedulerHttp: "scheduler-http-rpc",
    BootstrapHttp: "bootstrap-http-rpc",
    DomainHttp: "domain-http-rpc",
    ReorgHttp: "reorg-http-rpc",
    CollectionExtensionHttp: "collection-extension-http-rpc",
    Metadata: "metadata-rpc",
    WebSocketHead: "websocket-head-rpc",
    SchedulerWebSocket: "scheduler-ws-rpc",
} as const;

// Endpoint ID prefixes used to keep RPC provider labels stable and readable.
export const INDEXER_RPC_ENDPOINT_ID_PREFIX = {
    DefaultHttp: "rpc",
    PrimaryHttp: "primary-rpc",
    BackfillHttp: "backfill-rpc",
    SchedulerHttp: "scheduler-rpc",
    BootstrapHttp: "bootstrap-rpc",
    DomainHttp: "domain-rpc",
    ReorgHttp: "reorg-rpc",
    CollectionExtensionHttp: "collection-extension-rpc",
    Metadata: "metadata-rpc",
    WebSocketDefault: "ws-rpc",
    SchedulerWebSocket: "scheduler-ws-rpc",
} as const;

// Logger component labels emitted by indexer RPC adapters.
export const INDEXER_RPC_LOG_COMPONENT = {
    Http: "IndexerRpc",
    Metadata: "IndexerMetadataRpc",
    WebSocket: "IndexerWebSocketRpc",
} as const;

// Method labels used by metadata and WebSocket RPC observers.
export const INDEXER_RPC_METHOD = {
    WatchBlockNumber: "watchBlockNumber",
    TokenUri: "tokenURI",
    Erc1155Uri: "uri",
} as const;

// Metadata resolver metric names emitted around token URI RPC reads.
export const INDEXER_METADATA_RPC_METRIC = {
    ResolveLatency: "metadata.resolve.latency",
    ResolveFailure: "metadata.resolve.failure",
} as const;

// Metadata resolver result labels used by its latency metric.
export const INDEXER_METADATA_RPC_RESULT = {
    Ok: "ok",
    Error: "error",
} as const;
