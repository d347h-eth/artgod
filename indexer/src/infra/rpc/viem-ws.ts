import { createPublicClient, webSocket } from "viem";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import type { RpcWebSocketEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    errorLogFields,
    RpcObservability,
    type RpcEndpointSnapshot,
} from "@artgod/shared/observability/rpc";
import type { HeadSourcePort } from "../../ports/head-source.js";

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
        const component = options.component ?? "websocket-head-rpc";
        this.endpointSelector = new WeightedEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `${options.endpointIdPrefix ?? "ws-rpc"}-${index + 1}`,
                value: endpoint.url,
            })),
        );
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this.createClient = options.createClient ?? createViemWebSocketClient;
        this.rpcObservability = new RpcObservability({
            workspace: "indexer",
            component,
            protocol: "websocket",
            metrics: options.metrics,
            logComponent: "IndexerWebSocketRpc",
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
                event: "connect_started",
                method: "watchBlockNumber",
                endpoint,
                message: "RPC websocket connect started",
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
                            event: "head_received",
                            method: "watchBlockNumber",
                            endpoint: updatedEndpoint,
                            message: "RPC websocket head received",
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
                event: "connected",
                method: "watchBlockNumber",
                endpoint,
                message: "RPC websocket connected",
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
                event: "connection_failed",
                method: "watchBlockNumber",
                endpoint,
                level: "warn",
                message: "RPC websocket endpoint failed",
                extra: errorLogFields(error),
            });
        }
        this.onError?.(error);
        this.stopActiveConnection();
        this.clearReconnectTimer();
        if (endpoint) {
            this.rpcObservability.recordEndpointEvent({
                event: "reconnect_scheduled",
                method: "watchBlockNumber",
                endpoint,
                level: "warn",
                message: "RPC websocket reconnect scheduled",
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
                    event: "connection_stopped",
                    method: "watchBlockNumber",
                    endpoint,
                    message: "RPC websocket connection stopped",
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
