import { custom } from "viem";
import type { RpcEndpointConfig } from "../config/rpc-endpoints.js";
import { WeightedEndpointSelector } from "../config/weighted-endpoints.js";

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
};

let nextRequestId = 1;

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

    return custom({
        request: async ({ method, params }) => {
            const endpoint = selector.select();
            try {
                const result = await requestJsonRpc(fetchRpc, endpoint.value, {
                    jsonrpc: "2.0",
                    id: nextJsonRpcRequestId(),
                    method,
                    params: params ?? [],
                });
                selector.recordSuccess(endpoint.id);
                return result;
            } catch (error) {
                selector.recordFailure(endpoint.id);
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
    request: JsonRpcRequest,
): Promise<unknown> {
    const response = await fetchRpc(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(request),
    });
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
