// Env key for the Admin-only Chainlist privacy policy used by RPC auto-sourcing.
export const RPC_AUTO_SOURCING_TRACKING_POLICY_ENV_KEY =
    "RPC_AUTO_SOURCING_TRACKING_POLICY";

// Tracking policies accepted by the Admin RPC auto-sourcing command.
export const RPC_AUTO_SOURCING_TRACKING_POLICIES = {
    none: "none",
    limited: "limited",
    all: "all",
} as const;

export type RpcAutoSourcingTrackingPolicy =
    (typeof RPC_AUTO_SOURCING_TRACKING_POLICIES)[keyof typeof RPC_AUTO_SOURCING_TRACKING_POLICIES];

// Source modes accepted by the Admin RPC endpoint benchmark command.
export const RPC_ENDPOINT_BENCHMARK_SOURCES = {
    savedChainlist: "saved_chainlist",
    freshChainlist: "fresh_chainlist",
    configuredEndpoints: "configured_endpoints",
} as const;

export type RpcEndpointBenchmarkSource =
    (typeof RPC_ENDPOINT_BENCHMARK_SOURCES)[keyof typeof RPC_ENDPOINT_BENCHMARK_SOURCES];

// Normalizes untrusted Admin state to the default no-tracking sourcing policy.
export function normalizeRpcAutoSourcingTrackingPolicy(
    value: string | undefined,
): RpcAutoSourcingTrackingPolicy {
    if (value === RPC_AUTO_SOURCING_TRACKING_POLICIES.limited) {
        return RPC_AUTO_SOURCING_TRACKING_POLICIES.limited;
    }
    if (value === RPC_AUTO_SOURCING_TRACKING_POLICIES.all) {
        return RPC_AUTO_SOURCING_TRACKING_POLICIES.all;
    }
    return RPC_AUTO_SOURCING_TRACKING_POLICIES.none;
}
