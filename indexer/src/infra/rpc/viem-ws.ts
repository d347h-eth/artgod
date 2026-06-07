import { createPublicClient, webSocket } from "viem";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import type { RpcWebSocketEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    errorLogFields,
    RPC_OBSERVABILITY_EVENT,
    RPC_OBSERVABILITY_LOG_MESSAGE,
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
    type RpcEndpointSnapshot,
} from "@artgod/shared/observability/rpc";
import type { HeadSourcePort } from "../../ports/head-source.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_LOG_COMPONENT,
    INDEXER_RPC_METHOD,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "./observability.js";

type WatchBlockNumberOptions = Parameters<
    ReturnType<typeof createPublicClient>["watchBlockNumber"]
>[0];
type WebSocketHeadClient = {
    watchBlockNumber(options: WatchBlockNumberOptions): () => void;
};

export type ViemWebSocketHeadSourceOptions = {
    endpointIdPrefix?: string;
    component?: string;
    metrics?: Metrics;
    reconnectDelayMs?: number;
    createClient?: (url: string) => WebSocketHeadClient;
};

export class ViemWebSocketHeadSource implements HeadSourcePort {
    private readonly endpointSelector: WeightedEndpointSelector<string>;
    private readonly reconnectDelayMs: number;
    private readonly createClient: (url: string) => WebSocketHeadClient;
    private activeUnwatch: (() => void) | null = null;
    private activeEndpoint: RpcEndpointSnapshot | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private onHead: ((head: number) => void) | null = null;
    private onError: ((error: unknown) => void) | null = null;
    private readonly rpcObservability: RpcObservability;

    constructor(
        endpoints: readonly RpcWebSocketEndpointConfig[],
        options: ViemWebSocketHeadSourceOptions = {},
    ) {
        const component =
            options.component ?? INDEXER_RPC_OBSERVABILITY_COMPONENT.WebSocketHead;
        const endpointIdPrefix =
            options.endpointIdPrefix ??
            INDEXER_RPC_ENDPOINT_ID_PREFIX.WebSocketDefault;
        this.endpointSelector = new WeightedEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `${endpointIdPrefix}-${index + 1}`,
                value: endpoint.url,
            })),
        );
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this.createClient = options.createClient ?? createViemWebSocketClient;
        this.rpcObservability = new RpcObservability({
            workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
            component,
            protocol: RPC_PROTOCOL.WebSocket,
            metrics: options.metrics,
            logComponent: INDEXER_RPC_LOG_COMPONENT.WebSocket,
        });
        for (const endpoint of this.endpointSelector.snapshot()) {
            this.rpcObservability.recordConfiguredEndpoint(endpoint);
        }
    }

    async start(
        onHead: (head: number) => void,
        onError?: (error: unknown) => void,
    ): Promise<() => Promise<void>> {
        this.stopped = false;
        this.onHead = onHead;
        this.onError = onError ?? null;
        this.connect();

        return async () => {
            this.stopped = true;
            this.clearReconnectTimer();
            this.stopActiveConnection();
        };
    }

    private connect(): void {
        if (this.stopped) return;

        const endpoint = this.endpointSelector.selectHighestEffectiveWeight();
        try {
            this.rpcObservability.recordEndpointEvent({
                event: RPC_OBSERVABILITY_EVENT.ConnectStarted,
                method: INDEXER_RPC_METHOD.WatchBlockNumber,
                endpoint,
                message: RPC_OBSERVABILITY_LOG_MESSAGE.WebSocketConnectStarted,
            });
            const client = this.createClient(endpoint.value);
            this.activeUnwatch = client.watchBlockNumber({
                emitOnBegin: false,
                onBlockNumber: (blockNumber) => {
                    try {
                        const updatedEndpoint =
                            this.endpointSelector.recordSuccess(endpoint.id) ??
                            endpoint;
                        this.activeEndpoint = updatedEndpoint;
                        const parsedHead = toSafeNumber(
                            blockNumber,
                            "blockNumber",
                        );
                        this.rpcObservability.recordEndpointEvent({
                            event: RPC_OBSERVABILITY_EVENT.HeadReceived,
                            method: INDEXER_RPC_METHOD.WatchBlockNumber,
                            endpoint: updatedEndpoint,
                            message:
                                RPC_OBSERVABILITY_LOG_MESSAGE.WebSocketHeadReceived,
                            extra: { headNumber: parsedHead },
                        });
                        this.onHead?.(parsedHead);
                    } catch (error) {
                        this.handleEndpointError(endpoint.id, error);
                    }
                },
                onError: (error) => {
                    this.handleEndpointError(endpoint.id, error);
                },
            });
            this.activeEndpoint = endpoint;
            this.rpcObservability.recordEndpointEvent({
                event: RPC_OBSERVABILITY_EVENT.Connected,
                method: INDEXER_RPC_METHOD.WatchBlockNumber,
                endpoint,
                message: RPC_OBSERVABILITY_LOG_MESSAGE.WebSocketConnected,
            });
        } catch (error) {
            this.handleEndpointError(endpoint.id, error);
        }
    }

    private handleEndpointError(endpointId: string, error: unknown): void {
        if (this.stopped) return;
        const endpoint =
            this.endpointSelector.recordFailure(endpointId) ??
            this.activeEndpoint ??
            this.endpointSelector.snapshot().find((entry) => entry.id === endpointId);
        if (endpoint) {
            this.rpcObservability.recordEndpointEvent({
                event: RPC_OBSERVABILITY_EVENT.ConnectionFailed,
                method: INDEXER_RPC_METHOD.WatchBlockNumber,
                endpoint,
                level: "warn",
                message: RPC_OBSERVABILITY_LOG_MESSAGE.WebSocketEndpointFailed,
                extra: errorLogFields(error),
            });
        }
        this.onError?.(error);
        this.stopActiveConnection();
        this.clearReconnectTimer();
        if (endpoint) {
            this.rpcObservability.recordEndpointEvent({
                event: RPC_OBSERVABILITY_EVENT.ReconnectScheduled,
                method: INDEXER_RPC_METHOD.WatchBlockNumber,
                endpoint,
                level: "warn",
                message:
                    RPC_OBSERVABILITY_LOG_MESSAGE.WebSocketReconnectScheduled,
                extra: { reconnectDelayMs: this.reconnectDelayMs },
            });
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelayMs);
    }

    private stopActiveConnection(): void {
        const unwatch = this.activeUnwatch;
        const endpoint = this.activeEndpoint;
        this.activeUnwatch = null;
        this.activeEndpoint = null;
        if (unwatch) {
            if (endpoint) {
                this.rpcObservability.recordEndpointEvent({
                    event: RPC_OBSERVABILITY_EVENT.ConnectionStopped,
                    method: INDEXER_RPC_METHOD.WatchBlockNumber,
                    endpoint,
                    message:
                        RPC_OBSERVABILITY_LOG_MESSAGE.WebSocketConnectionStopped,
                });
            }
            unwatch();
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}

function createViemWebSocketClient(url: string): WebSocketHeadClient {
    return createPublicClient({
        transport: webSocket(url),
    });
}

function toSafeNumber(value: bigint, label: string): number {
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
        throw new Error(`${label} exceeds JS safe integer: ${String(value)}`);
    }
    return num;
}
