import { Buffer } from "node:buffer";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { getDefaultRpcEndpointResilienceConfig } from "@artgod/shared/config/rpc-resilience";
import {
    WeightedEndpointSelector,
    type WeightedEndpointSelection,
} from "@artgod/shared/config/weighted-endpoints";
import { fetchWithRpcRequestTimeout } from "@artgod/shared/evm/rpc-resilience";
import {
    RPC_OBSERVABILITY_SENTINEL,
    type RpcCallContext,
    type RpcEndpointAttemptContext,
    type RpcObservability,
} from "@artgod/shared/observability/rpc";

export type OpenSeaSdkRpcConnectionOptions = {
    endpointIdPrefix: string;
    fetchFn?: typeof fetch;
    rpcObservability: RpcObservability;
    requestTimeoutMs?: number;
};

export type OpenSeaSdkRpcConnection = {
    body: string | Uint8Array | null;
    clone(): OpenSeaSdkRpcConnection;
    send(): Promise<OpenSeaSdkRpcResponse>;
    setHeader(key: string, value: string | number): void;
};

export type OpenSeaSdkRpcResponse = {
    readonly bodyJson: unknown;
    assertOk(): void;
};

type RpcEndpointSelection = WeightedEndpointSelection<string>;

type ResponseObservation = {
    rpcObservability: RpcObservability;
    selector: WeightedEndpointSelector<string>;
    endpoint: RpcEndpointSelection;
    call: RpcCallContext;
    attempt: RpcEndpointAttemptContext;
};

const HTTP_METHOD_POST = "POST";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE = "application/json";
const BATCH_RPC_METHOD_LABEL = "batch";
const DEFAULT_RPC_REQUEST_TIMEOUT_MS =
    getDefaultRpcEndpointResilienceConfig().requestTimeoutMs;

// Creates the FetchRequest-shaped object OpenSea passes into ethers' JsonRpcProvider.
export function createOpenSeaSdkRpcConnection(
    endpoints: readonly RpcEndpointConfig[],
    options: OpenSeaSdkRpcConnectionOptions,
): OpenSeaSdkRpcConnection {
    const selector = new WeightedEndpointSelector(
        endpoints.map((endpoint, index) => ({
            ...endpoint,
            id: `${options.endpointIdPrefix}-${index + 1}`,
            value: endpoint.url,
        })),
    );
    for (const endpoint of selector.snapshot()) {
        options.rpcObservability.recordConfiguredEndpoint(endpoint);
    }

    return new ObservedOpenSeaSdkRpcConnection(
        selector,
        options.rpcObservability,
        options.fetchFn ?? fetch,
        options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS,
    );
}

class ObservedOpenSeaSdkRpcConnection implements OpenSeaSdkRpcConnection {
    private readonly headers: Record<string, string>;
    private requestBody: string | Uint8Array | null;

    constructor(
        private readonly selector: WeightedEndpointSelector<string>,
        private readonly rpcObservability: RpcObservability,
        private readonly fetchRpc: typeof fetch,
        private readonly requestTimeoutMs: number,
        headers: Record<string, string> = {},
        body: string | Uint8Array | null = null,
    ) {
        this.headers = { ...headers };
        this.requestBody = body;
    }

    get body(): string | Uint8Array | null {
        return this.requestBody;
    }

    set body(body: string | Uint8Array | null) {
        this.requestBody = body;
    }

    clone(): OpenSeaSdkRpcConnection {
        return new ObservedOpenSeaSdkRpcConnection(
            this.selector,
            this.rpcObservability,
            this.fetchRpc,
            this.requestTimeoutMs,
            this.headers,
            this.requestBody,
        );
    }

    setHeader(key: string, value: string | number): void {
        this.headers[key.toLowerCase()] = String(value);
    }

    async send(): Promise<OpenSeaSdkRpcResponse> {
        const method = parseJsonRpcMethodLabel(this.requestBody);
        const call = this.rpcObservability.startCall(method);
        const endpoint = this.selector.select();
        const attempt = this.rpcObservability.startEndpointAttempt(
            call,
            endpoint,
            1,
        );
        try {
            const response = await fetchWithRpcRequestTimeout(
                this.fetchRpc,
                endpoint.value,
                {
                    method: HTTP_METHOD_POST,
                    headers: this.headers,
                    body:
                        this.requestBody === null
                            ? undefined
                            : bodyToString(this.requestBody),
                },
                this.requestTimeoutMs,
            );
            const bodyText = await response.text();
            return new ObservedOpenSeaSdkRpcResponse(
                {
                    status: response.status,
                    statusText: response.statusText,
                    bodyText,
                },
                {
                    rpcObservability: this.rpcObservability,
                    selector: this.selector,
                    endpoint,
                    call,
                    attempt,
                },
            );
        } catch (error) {
            recordRpcFailure(
                {
                    rpcObservability: this.rpcObservability,
                    selector: this.selector,
                    endpoint,
                    call,
                    attempt,
                },
                error,
            );
            throw error;
        }
    }
}

class ObservedOpenSeaSdkRpcResponse implements OpenSeaSdkRpcResponse {
    private parsedBody: unknown;
    private parsed = false;
    private observed = false;
    private readonly status: number;
    private readonly statusText: string;
    private readonly bodyText: string;

    constructor(
        response: {
            status: number;
            statusText: string;
            bodyText: string;
        },
        private readonly observation: ResponseObservation,
    ) {
        this.status = response.status;
        this.statusText = response.statusText;
        this.bodyText = response.bodyText;
        if (!this.isOk()) {
            this.recordFailure(
                new OpenSeaSdkRpcHttpError(this.status, this.statusText),
            );
        }
    }

    get bodyJson(): unknown {
        if (!this.parsed) {
            try {
                this.parsedBody = JSON.parse(this.bodyText);
                this.parsed = true;
            } catch (error) {
                const parsedError = new OpenSeaSdkRpcInvalidJsonError(error);
                this.recordFailure(parsedError);
                throw parsedError;
            }
        }

        const rpcError = firstJsonRpcError(this.parsedBody);
        if (rpcError) {
            this.recordFailure(new OpenSeaSdkJsonRpcError(rpcError));
        } else {
            this.recordSuccess();
        }
        return this.parsedBody;
    }

    assertOk(): void {
        if (!this.isOk()) {
            throw new OpenSeaSdkRpcHttpError(this.status, this.statusText);
        }
    }

    private isOk(): boolean {
        return this.status >= 200 && this.status < 300;
    }

    private recordSuccess(): void {
        if (this.observed) return;
        this.observed = true;
        const endpoint =
            this.observation.selector.recordSuccess(
                this.observation.endpoint.id,
            ) ?? this.observation.endpoint;
        this.observation.rpcObservability.recordEndpointAttemptSuccess(
            this.observation.attempt,
            endpoint,
        );
        this.observation.rpcObservability.recordCallSuccess(
            this.observation.call,
            endpoint,
        );
    }

    private recordFailure(error: unknown): void {
        if (this.observed) return;
        this.observed = true;
        recordRpcFailure(this.observation, error);
    }
}

class OpenSeaSdkRpcHttpError extends Error {
    constructor(status: number, statusText: string) {
        super(`OpenSea SDK RPC endpoint returned HTTP ${status} ${statusText}`);
        this.name = "OpenSeaSdkRpcHttpError";
    }
}

class OpenSeaSdkRpcInvalidJsonError extends Error {
    constructor(cause: unknown) {
        super("OpenSea SDK RPC endpoint returned invalid JSON");
        this.name = "OpenSeaSdkRpcInvalidJsonError";
        this.cause = cause;
    }
}

class OpenSeaSdkJsonRpcError extends Error {
    constructor(error: { code?: unknown; message?: unknown }) {
        super(
            typeof error.message === "string" && error.message.trim().length > 0
                ? error.message
                : "OpenSea SDK RPC endpoint returned a JSON-RPC error",
        );
        this.name = "OpenSeaSdkJsonRpcError";
    }
}

function recordRpcFailure(
    observation: ResponseObservation,
    error: unknown,
): void {
    const endpoint =
        observation.selector.recordFailure(observation.endpoint.id) ??
        observation.endpoint;
    observation.rpcObservability.recordEndpointAttemptFailure(
        observation.attempt,
        endpoint,
        error,
    );
    observation.rpcObservability.recordCallFailure(
        observation.call,
        endpoint,
        error,
    );
}

function parseJsonRpcMethodLabel(body: string | Uint8Array | null): string {
    if (body === null) {
        return RPC_OBSERVABILITY_SENTINEL.NoMethod;
    }
    try {
        const parsed = JSON.parse(bodyToString(body));
        if (Array.isArray(parsed)) {
            if (parsed.length === 1) {
                return parseSingleJsonRpcMethod(parsed[0]);
            }
            return BATCH_RPC_METHOD_LABEL;
        }
        return parseSingleJsonRpcMethod(parsed);
    } catch {
        return RPC_OBSERVABILITY_SENTINEL.NoMethod;
    }
}

function parseSingleJsonRpcMethod(payload: unknown): string {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const method = (payload as { method?: unknown }).method;
        if (typeof method === "string" && method.trim().length > 0) {
            return method;
        }
    }
    return RPC_OBSERVABILITY_SENTINEL.NoMethod;
}

function firstJsonRpcError(
    payload: unknown,
): { code?: unknown; message?: unknown } | null {
    if (Array.isArray(payload)) {
        for (const entry of payload) {
            const error = firstJsonRpcError(entry);
            if (error) return error;
        }
        return null;
    }
    if (payload && typeof payload === "object") {
        const error = (payload as { error?: unknown }).error;
        if (error && typeof error === "object" && !Array.isArray(error)) {
            return error as { code?: unknown; message?: unknown };
        }
    }
    return null;
}

function bodyToString(body: string | Uint8Array): string {
    return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}
