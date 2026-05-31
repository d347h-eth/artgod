import { createPublicClient, webSocket } from "viem";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import type { RpcWebSocketEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import type { HeadSourcePort } from "../../ports/head-source.js";

type WatchBlockNumberOptions = Parameters<
    ReturnType<typeof createPublicClient>["watchBlockNumber"]
>[0];
type WebSocketHeadClient = {
    watchBlockNumber(options: WatchBlockNumberOptions): () => void;
};

export type ViemWebSocketHeadSourceOptions = {
    endpointIdPrefix?: string;
    reconnectDelayMs?: number;
    createClient?: (url: string) => WebSocketHeadClient;
};

export class ViemWebSocketHeadSource implements HeadSourcePort {
    private readonly endpointSelector: WeightedEndpointSelector<string>;
    private readonly reconnectDelayMs: number;
    private readonly createClient: (url: string) => WebSocketHeadClient;
    private activeUnwatch: (() => void) | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private onHead: ((head: number) => void) | null = null;
    private onError: ((error: unknown) => void) | null = null;

    constructor(
        endpoints: readonly RpcWebSocketEndpointConfig[],
        options: ViemWebSocketHeadSourceOptions = {},
    ) {
        this.endpointSelector = new WeightedEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `${options.endpointIdPrefix ?? "ws-rpc"}-${index + 1}`,
                value: endpoint.url,
            })),
        );
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
        this.createClient = options.createClient ?? createViemWebSocketClient;
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
            const client = this.createClient(endpoint.value);
            this.activeUnwatch = client.watchBlockNumber({
                emitOnBegin: false,
                onBlockNumber: (blockNumber) => {
                    try {
                        this.endpointSelector.recordSuccess(endpoint.id);
                        this.onHead?.(toSafeNumber(blockNumber, "blockNumber"));
                    } catch (error) {
                        this.handleEndpointError(endpoint.id, error);
                    }
                },
                onError: (error) => {
                    this.handleEndpointError(endpoint.id, error);
                },
            });
        } catch (error) {
            this.handleEndpointError(endpoint.id, error);
        }
    }

    private handleEndpointError(endpointId: string, error: unknown): void {
        if (this.stopped) return;
        this.endpointSelector.recordFailure(endpointId);
        this.onError?.(error);
        this.stopActiveConnection();
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelayMs);
    }

    private stopActiveConnection(): void {
        const unwatch = this.activeUnwatch;
        this.activeUnwatch = null;
        if (unwatch) unwatch();
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
