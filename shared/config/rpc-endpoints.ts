import {
    DEFAULT_ENDPOINT_WEIGHT,
    parseWeightedEndpointConfigList,
    serializeWeightedEndpointConfigList,
    WeightedEndpointSelector,
    type WeightedEndpointConfig,
    type WeightedEndpointListValidation,
    type WeightedEndpointSelection,
    type WeightedEndpointTarget,
} from "./weighted-endpoints.js";

export type RpcEndpointConfig = WeightedEndpointConfig;
export type RpcWebSocketEndpointConfig = WeightedEndpointConfig;
export type WeightedRpcEndpointTarget<T> = WeightedEndpointTarget<T>;
export type WeightedRpcEndpointSelection<T> = WeightedEndpointSelection<T>;

export const DEFAULT_RPC_ENDPOINT_WEIGHT = DEFAULT_ENDPOINT_WEIGHT;
export const WeightedRpcEndpointSelector = WeightedEndpointSelector;

const HTTP_RPC_ENDPOINT_VALIDATION: WeightedEndpointListValidation = {
    key: "RPC_URL",
    allowedProtocols: ["http:", "https:"],
    explicitSchemePattern: /^https?:\/\//,
    protocolLabel: "http or https",
};

const WS_RPC_ENDPOINT_VALIDATION: WeightedEndpointListValidation = {
    key: "RPC_WS_URL",
    allowedProtocols: ["ws:", "wss:"],
    explicitSchemePattern: /^wss?:\/\//,
    protocolLabel: "ws or wss",
};

// Parses the runtime HTTP JSON-RPC endpoint list from the structured env value.
export function parseRpcEndpointConfigList(
    value: string | undefined,
    key = "RPC_URL",
): RpcEndpointConfig[] {
    return parseWeightedEndpointConfigList(value, {
        ...HTTP_RPC_ENDPOINT_VALIDATION,
        key,
    });
}

// Parses the runtime WebSocket JSON-RPC endpoint list from the structured env value.
export function parseRpcWebSocketEndpointConfigList(
    value: string | undefined,
    key = "RPC_WS_URL",
): RpcWebSocketEndpointConfig[] {
    return parseWeightedEndpointConfigList(value, {
        ...WS_RPC_ENDPOINT_VALIDATION,
        key,
    });
}

// Serializes validated HTTP endpoints for Admin-managed settings and env rendering.
export function serializeRpcEndpointConfigList(
    endpoints: readonly RpcEndpointConfig[],
): string {
    return serializeWeightedEndpointConfigList(
        endpoints,
        HTTP_RPC_ENDPOINT_VALIDATION,
    );
}

// Serializes validated WebSocket endpoints for Admin-managed settings and env rendering.
export function serializeRpcWebSocketEndpointConfigList(
    endpoints: readonly RpcWebSocketEndpointConfig[],
): string {
    return serializeWeightedEndpointConfigList(
        endpoints,
        WS_RPC_ENDPOINT_VALIDATION,
    );
}
