import { custom } from "viem";
import type { RpcEndpointConfig } from "../config/rpc-endpoints.js";
import { getDefaultRpcEndpointResilienceConfig } from "../config/rpc-resilience.js";
import { WeightedEndpointSelector } from "../config/weighted-endpoints.js";
import type { RpcObservability } from "../observability/rpc.js";
import { executeObservedRpcEndpointCall } from "./rpc-execution.js";
import {
    CircuitBreaker,
    fetchWithRpcRequestTimeout,
    TokenBucketRateLimiter,
    VIEM_TRANSPORT_RETRY_DISABLED,
    type RpcEndpointResilienceConfig,
    type RpcRetryPolicy,
} from "./rpc-resilience.js";

type JsonRpcRequest = {
    jsonrpc: typeof JSON_RPC_VERSION;
    id: number;
    method: string;
    params: unknown;
};

type JsonRpcError = {
    code: number;
    message: string;
    data?: unknown;
};

type JsonRpcResponse = {
    id: number;
    result?: unknown;
    error?: JsonRpcError;
};

// Options for single-attempt weighted JSON-RPC transports.
export type WeightedRpcTransportOptions = {
    endpointIdPrefix?: string;
    fetchFn?: typeof fetch;
    rpcObservability?: RpcObservability;
    requestTimeoutMs?: number;
};

// Options for retrying weighted JSON-RPC transports.
export type ResilientWeightedRpcTransportOptions = {
    endpointIdPrefix?: string;
    fetchFn?: typeof fetch;
    resilience: RpcEndpointResilienceConfig;
    retryPolicy: RpcRetryPolicy;
    rpcObservability?: RpcObservability;
    sleep?: (ms: number) => Promise<void>;
};

type ResilientRpcEndpoint = {
    url: string;
    circuitBreaker: CircuitBreaker;
    rateLimiter: TokenBucketRateLimiter;
};

let nextRequestId = 1;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS =
    getDefaultRpcEndpointResilienceConfig().requestTimeoutMs;
const DEFAULT_RPC_ENDPOINT_ID_PREFIX = "rpc";
const JSON_RPC_VERSION = "2.0";
const HTTP_METHOD_POST = "POST";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE = "application/json";
const RPC_HTTP_STATUS_ERROR_PREFIX = "RPC endpoint returned HTTP";
const JSON_RPC_ERROR_PREFIX = "JSON-RPC error";

// Error prefix used whenever a read-only RPC boundary rejects wallet or submission authority.
export const READ_ONLY_RPC_METHOD_REJECTED_ERROR =
    "Read-only RPC boundary rejected forbidden method";

// JSON-RPC methods that can submit or request a transaction write.
export const EVM_STATE_CHANGING_RPC_METHOD = {
    SendRawTransaction: "eth_sendRawTransaction",
    SendTransaction: "eth_sendTransaction",
    SendUserOperation: "eth_sendUserOperation",
    SendPrivateTransaction: "eth_sendPrivateTransaction",
    PersonalSendTransaction: "personal_sendTransaction",
    WalletSendTransaction: "wallet_sendTransaction",
    WalletSendCalls: "wallet_sendCalls",
} as const;

// JSON-RPC methods that ask a connected wallet or node to produce a signature.
export const EVM_SIGNING_RPC_METHOD = {
    EthSign: "eth_sign",
    EthSignTransaction: "eth_signTransaction",
    EthSignTypedData: "eth_signTypedData",
    EthSignTypedDataV3: "eth_signTypedData_v3",
    EthSignTypedDataV4: "eth_signTypedData_v4",
    PersonalSign: "personal_sign",
    WalletSignTransaction: "wallet_signTransaction",
} as const;

const EVM_READ_ONLY_FORBIDDEN_RPC_METHODS = new Set<string>([
    ...Object.values(EVM_STATE_CHANGING_RPC_METHOD),
    ...Object.values(EVM_SIGNING_RPC_METHOD),
]);

// Builds a viem transport that chooses a weighted endpoint for each JSON-RPC request.
export function createWeightedRpcTransport(
    endpoints: readonly RpcEndpointConfig[],
    options: WeightedRpcTransportOptions = {},
) {
    const selector = new WeightedEndpointSelector(
        endpoints.map((endpoint, index) => ({
            ...endpoint,
            id: `${options.endpointIdPrefix ?? DEFAULT_RPC_ENDPOINT_ID_PREFIX}-${index + 1}`,
            value: endpoint.url,
        })),
    );
    const fetchRpc = options.fetchFn ?? fetch;
    const requestTimeoutMs =
        options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
    for (const endpoint of selector.snapshot()) {
        options.rpcObservability?.recordConfiguredEndpoint(endpoint);
    }

    return custom(
        {
            request: async ({ method, params }) => {
                return executeObservedRpcEndpointCall({
                    selector,
                    method,
                    rpcObservability: options.rpcObservability,
                    execute: (endpoint) =>
                        requestJsonRpc(
                            fetchRpc,
                            endpoint.value,
                            requestTimeoutMs,
                            {
                                jsonrpc: JSON_RPC_VERSION,
                                id: nextJsonRpcRequestId(),
                                method,
                                params: params ?? [],
                            },
                        ),
                });
            },
        },
        { retryCount: VIEM_TRANSPORT_RETRY_DISABLED },
    );
}

// Builds a viem transport with shared retry, circuit, rate-limit, and endpoint weighting policy.
export function createResilientWeightedRpcTransport(
    endpoints: readonly RpcEndpointConfig[],
    options: ResilientWeightedRpcTransportOptions,
) {
    const selector = new WeightedEndpointSelector(
        endpoints.map((endpoint, index) => ({
            ...endpoint,
            id: `${options.endpointIdPrefix ?? DEFAULT_RPC_ENDPOINT_ID_PREFIX}-${index + 1}`,
            value: {
                url: endpoint.url,
                circuitBreaker: new CircuitBreaker(
                    options.resilience.circuitBreaker,
                ),
                rateLimiter: new TokenBucketRateLimiter(
                    options.resilience.rateLimiter,
                ),
            },
        })),
    );
    const fetchRpc = options.fetchFn ?? fetch;
    for (const endpoint of selector.snapshot()) {
        options.rpcObservability?.recordConfiguredEndpoint(endpoint);
    }

    return custom(
        {
            request: async ({ method, params }) => {
                assertReadOnlyEvmRpcMethod(method);

                return executeObservedRpcEndpointCall({
                    selector,
                    method,
                    rpcObservability: options.rpcObservability,
                    retryPolicy: options.retryPolicy,
                    sleep: options.sleep,
                    circuitBreaker: (endpoint) => endpoint.value.circuitBreaker,
                    rateLimiter: (endpoint) => endpoint.value.rateLimiter,
                    execute: (endpoint) =>
                        requestJsonRpc(
                            fetchRpc,
                            endpoint.value.url,
                            options.resilience.requestTimeoutMs,
                            {
                                jsonrpc: JSON_RPC_VERSION,
                                id: nextJsonRpcRequestId(),
                                method,
                                params: params ?? [],
                            },
                        ),
                });
            },
        },
        { retryCount: VIEM_TRANSPORT_RETRY_DISABLED },
    );
}

// Rejects transaction submission and signing before a read-only endpoint is selected.
export function assertReadOnlyEvmRpcMethod(method: string): void {
    if (EVM_READ_ONLY_FORBIDDEN_RPC_METHODS.has(method)) {
        throw new Error(`${READ_ONLY_RPC_METHOD_REJECTED_ERROR}: ${method}`);
    }
}

function nextJsonRpcRequestId(): number {
    const id = nextRequestId;
    nextRequestId =
        nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
    return id;
}

async function requestJsonRpc(
    fetchRpc: typeof fetch,
    url: string,
    requestTimeoutMs: number,
    request: JsonRpcRequest,
): Promise<unknown> {
    const response = await fetchWithRpcRequestTimeout(
        fetchRpc,
        url,
        {
            method: HTTP_METHOD_POST,
            headers: {
                [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
            },
            body: JSON.stringify(request),
        },
        requestTimeoutMs,
    );
    if (!response.ok) {
        throw new Error(`${RPC_HTTP_STATUS_ERROR_PREFIX} ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
        throw buildJsonRpcError(payload.error);
    }
    return payload.result;
}

function buildJsonRpcError(error: JsonRpcError): Error {
    const parsed = new Error(
        error.message || `${JSON_RPC_ERROR_PREFIX} ${error.code}`,
    );
    Object.assign(parsed, {
        code: error.code,
        data: error.data,
    });
    return parsed;
}
