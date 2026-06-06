import { custom } from "viem";
import type { RpcEndpointConfig } from "../config/rpc-endpoints.js";
import { getDefaultRpcEndpointResilienceConfig } from "../config/rpc-resilience.js";
import {
    WeightedEndpointSelector,
    type WeightedEndpointSelection,
} from "../config/weighted-endpoints.js";
import type { RpcCallContext, RpcObservability } from "../observability/rpc.js";
import {
    CircuitBreaker,
    CircuitOpenError,
    executeWithRpcRetry,
    fetchWithRpcRequestTimeout,
    TokenBucketRateLimiter,
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

type ResilientRpcEndpointSelection =
    WeightedEndpointSelection<ResilientRpcEndpoint>;

type ResilientRpcAttemptInput = {
    selector: WeightedEndpointSelector<ResilientRpcEndpoint>;
    fetchRpc: typeof fetch;
    requestTimeoutMs: number;
    method: string;
    params: unknown;
    attempt: number;
    call?: RpcCallContext;
    rpcObservability?: RpcObservability;
    onEndpointObserved?: (endpoint: ResilientRpcEndpointSelection) => void;
};

type ResilientRpcAttemptResult = {
    endpoint: ResilientRpcEndpointSelection;
    result: unknown;
};

let nextRequestId = 1;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS =
    getDefaultRpcEndpointResilienceConfig().requestTimeoutMs;
const DEFAULT_RPC_ENDPOINT_ID_PREFIX = "rpc";
const JSON_RPC_VERSION = "2.0";
const HTTP_METHOD_POST = "POST";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE = "application/json";
const VIEM_TRANSPORT_RETRY_DISABLED = 0;
const RPC_HTTP_STATUS_ERROR_PREFIX = "RPC endpoint returned HTTP";
const JSON_RPC_ERROR_PREFIX = "JSON-RPC error";

// Error prefix used when a retrying transport rejects a transaction-submitting method.
export const RPC_STATE_CHANGING_METHOD_REJECTED_ERROR =
    "Resilient RPC transport rejected state-changing method";

// JSON-RPC methods that can submit or request a transaction write.
export const EVM_STATE_CHANGING_RPC_METHOD = {
    SendRawTransaction: "eth_sendRawTransaction",
    SendTransaction: "eth_sendTransaction",
    WalletSendTransaction: "wallet_sendTransaction",
} as const;

const EVM_STATE_CHANGING_RPC_METHODS = new Set<string>(
    Object.values(EVM_STATE_CHANGING_RPC_METHOD),
);

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
                const call = options.rpcObservability?.startCall(method);
                const endpoint = selector.select();
                const attempt =
                    call &&
                    options.rpcObservability?.startEndpointAttempt(
                        call,
                        endpoint,
                        1,
                    );
                try {
                    const result = await requestJsonRpc(
                        fetchRpc,
                        endpoint.value,
                        requestTimeoutMs,
                        {
                            jsonrpc: JSON_RPC_VERSION,
                            id: nextJsonRpcRequestId(),
                            method,
                            params: params ?? [],
                        },
                    );
                    const updatedEndpoint =
                        selector.recordSuccess(endpoint.id) ?? endpoint;
                    if (attempt) {
                        options.rpcObservability?.recordEndpointAttemptSuccess(
                            attempt,
                            updatedEndpoint,
                        );
                    }
                    if (call) {
                        options.rpcObservability?.recordCallSuccess(
                            call,
                            updatedEndpoint,
                        );
                    }
                    return result;
                } catch (error) {
                    const updatedEndpoint =
                        selector.recordFailure(endpoint.id) ?? endpoint;
                    if (attempt) {
                        options.rpcObservability?.recordEndpointAttemptFailure(
                            attempt,
                            updatedEndpoint,
                            error,
                        );
                    }
                    if (call) {
                        options.rpcObservability?.recordCallFailure(
                            call,
                            updatedEndpoint,
                            error,
                        );
                    }
                    throw error;
                }
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
                assertRetryableRpcMethod(method);

                const call = options.rpcObservability?.startCall(method);
                let lastEndpoint: ResilientRpcEndpointSelection | null = null;
                try {
                    const result = await executeWithRpcRetry({
                        policy: options.retryPolicy,
                        sleep: options.sleep,
                        executeAttempt: async (attempt) => {
                            const attemptResult =
                                await executeResilientRpcAttempt({
                                    selector,
                                    fetchRpc,
                                    requestTimeoutMs:
                                        options.resilience.requestTimeoutMs,
                                    method,
                                    params: params ?? [],
                                    attempt,
                                    call,
                                    rpcObservability: options.rpcObservability,
                                    onEndpointObserved: (endpoint) => {
                                        lastEndpoint = endpoint;
                                    },
                                });
                            return attemptResult;
                        },
                        onRetryScheduled: ({
                            attempt,
                            nextAttempt,
                            delayMs,
                        }) => {
                            if (!lastEndpoint) return;
                            options.rpcObservability?.recordRetryScheduled({
                                method,
                                endpoint: lastEndpoint,
                                attempt,
                                nextAttempt,
                                delayMs,
                            });
                        },
                    });
                    if (call) {
                        options.rpcObservability?.recordCallSuccess(
                            call,
                            result.endpoint,
                        );
                    }
                    return result.result;
                } catch (error) {
                    if (call) {
                        options.rpcObservability?.recordCallFailure(
                            call,
                            lastEndpoint,
                            error,
                        );
                    }
                    throw error;
                }
            },
        },
        { retryCount: VIEM_TRANSPORT_RETRY_DISABLED },
    );
}

async function executeResilientRpcAttempt(
    input: ResilientRpcAttemptInput,
): Promise<ResilientRpcAttemptResult> {
    const endpoint = input.selector.select();
    input.onEndpointObserved?.(endpoint);
    const attemptContext =
        input.call &&
        input.rpcObservability?.startEndpointAttempt(
            input.call,
            endpoint,
            input.attempt,
        );

    try {
        const result = await endpoint.value.circuitBreaker.execute(async () => {
            const waitedMs = await endpoint.value.rateLimiter.acquire();
            if (waitedMs > 0) {
                input.rpcObservability?.recordRateLimitWait({
                    method: input.method,
                    endpoint,
                    waitedMs,
                });
            }

            return requestJsonRpc(
                input.fetchRpc,
                endpoint.value.url,
                input.requestTimeoutMs,
                {
                    jsonrpc: JSON_RPC_VERSION,
                    id: nextJsonRpcRequestId(),
                    method: input.method,
                    params: input.params,
                },
            );
        });
        const updatedEndpoint =
            input.selector.recordSuccess(endpoint.id) ?? endpoint;
        input.onEndpointObserved?.(updatedEndpoint);
        if (attemptContext) {
            input.rpcObservability?.recordEndpointAttemptSuccess(
                attemptContext,
                updatedEndpoint,
            );
        }
        return {
            endpoint: updatedEndpoint,
            result,
        };
    } catch (error) {
        const updatedEndpoint =
            input.selector.recordFailure(endpoint.id) ?? endpoint;
        input.onEndpointObserved?.(updatedEndpoint);
        if (error instanceof CircuitOpenError) {
            input.rpcObservability?.recordCircuitOpen(
                input.method,
                updatedEndpoint,
                error,
            );
        }
        if (attemptContext) {
            input.rpcObservability?.recordEndpointAttemptFailure(
                attemptContext,
                updatedEndpoint,
                error,
            );
        }
        throw error;
    }
}

function assertRetryableRpcMethod(method: string): void {
    if (EVM_STATE_CHANGING_RPC_METHODS.has(method)) {
        throw new Error(
            `${RPC_STATE_CHANGING_METHOD_REJECTED_ERROR}: ${method}`,
        );
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
