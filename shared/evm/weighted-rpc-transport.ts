import { custom } from "viem";
import type { RpcEndpointConfig } from "../config/rpc-endpoints.js";
import { getDefaultRpcEndpointResilienceConfig } from "../config/rpc-resilience.js";
import { WeightedEndpointSelector } from "../config/weighted-endpoints.js";
import type { RpcObservability } from "../observability/rpc.js";
import { fetchWithRpcRequestTimeout } from "./rpc-resilience.js";

type JsonRpcRequest = {
    jsonrpc: "2.0";
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

export type WeightedRpcTransportOptions = {
    endpointIdPrefix?: string;
    fetchFn?: typeof fetch;
    rpcObservability?: RpcObservability;
    requestTimeoutMs?: number;
};

let nextRequestId = 1;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS =
    getDefaultRpcEndpointResilienceConfig().requestTimeoutMs;

// Builds a viem transport that chooses a weighted endpoint for each JSON-RPC request.
export function createWeightedRpcTransport(
    endpoints: readonly RpcEndpointConfig[],
    options: WeightedRpcTransportOptions = {},
) {
    const selector = new WeightedEndpointSelector(
        endpoints.map((endpoint, index) => ({
            ...endpoint,
            id: `${options.endpointIdPrefix ?? "rpc"}-${index + 1}`,
            value: endpoint.url,
        })),
    );
    const fetchRpc = options.fetchFn ?? fetch;
    const requestTimeoutMs =
        options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
    for (const endpoint of selector.snapshot()) {
        options.rpcObservability?.recordConfiguredEndpoint(endpoint);
    }

    return custom({
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
                        jsonrpc: "2.0",
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
    });
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
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify(request),
        },
        requestTimeoutMs,
    );
    if (!response.ok) {
        throw new Error(`RPC endpoint returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
        throw buildJsonRpcError(payload.error);
    }
    return payload.result;
}

function buildJsonRpcError(error: JsonRpcError): Error {
    const parsed = new Error(error.message || `JSON-RPC error ${error.code}`);
    Object.assign(parsed, {
        code: error.code,
        data: error.data,
    });
    return parsed;
}
