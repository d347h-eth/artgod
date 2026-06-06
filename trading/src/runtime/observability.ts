// Metrics prefix used by trading runtime scrape endpoints.
export const TRADING_METRICS_PREFIX = "artgod_trading_";

// Worker labels used by trading metrics default labels.
export const TRADING_METRICS_WORKER = {
    BiddingBot: "bidding-bot",
} as const;

// Log component emitted by the shared runtime metrics bootstrapper.
export const TRADING_METRICS_LOG_COMPONENT = "TradingMetrics";

// Component labels that split trading RPC metrics by integration lane.
export const TRADING_RPC_OBSERVABILITY_COMPONENT = {
    BiddingReadOnlyViem: "bidding-read-only-viem-rpc",
    BiddingWriteCapableViem: "bidding-write-capable-viem-rpc",
    OpenSeaSdk: "bidding-opensea-sdk-rpc",
} as const;

// Endpoint ID prefixes used by trading RPC endpoint metrics.
export const TRADING_RPC_ENDPOINT_ID_PREFIX = {
    BiddingReadOnlyViem: "trading-read-only-rpc",
    BiddingWriteCapableViem: "trading-write-capable-rpc",
    OpenSeaSdk: "trading-opensea-sdk-rpc",
} as const;

// Log component emitted by trading RPC adapters.
export const TRADING_RPC_LOG_COMPONENT = "TradingRpc";
