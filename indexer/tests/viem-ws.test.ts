import { describe, expect, it, vi } from "vitest";
import { ViemWebSocketHeadSource } from "../src/infra/rpc/viem-ws.js";
import type {
    MetricLabels,
    Metrics,
} from "@artgod/shared/observability/metrics";

type WatchOptions = {
    emitOnBegin: boolean;
    onBlockNumber: (blockNumber: bigint) => void;
    onError: (error: unknown) => void;
};

class CapturingMetrics implements Metrics {
    readonly increments: Array<{
        name: string;
        value?: number;
        labels?: MetricLabels;
    }> = [];
    readonly gauges: Array<{ name: string; value: number; labels?: MetricLabels }> =
        [];
    readonly histograms: Array<{
        name: string;
        value: number;
        labels?: MetricLabels;
    }> = [];

    increment(name: string, value?: number, labels?: MetricLabels): void {
        this.increments.push({ name, value, labels });
    }

    gauge(name: string, value: number, labels?: MetricLabels): void {
        this.gauges.push({ name, value, labels });
    }

    histogram(name: string, value: number, labels?: MetricLabels): void {
        this.histograms.push({ name, value, labels });
    }
}

describe("ViemWebSocketHeadSource", () => {
    it("connects to the highest ranked websocket endpoint on start", async () => {
        const watches = new Map<string, WatchOptions>();
        const source = new ViemWebSocketHeadSource(
            [
                { url: "wss://ws-a.example", weight: 1 },
                { url: "wss://ws-b.example", weight: 3 },
            ],
            {
                createClient: (url) => ({
                    watchBlockNumber: (options) => {
                        watches.set(url, options as WatchOptions);
                        return () => {};
                    },
                }),
            },
        );

        const stop = await source.start(() => {});

        expect(watches.has("wss://ws-b.example")).toBe(true);

        await stop();
    });

    it("demotes failed websocket endpoints and reconnects to fallback endpoints", async () => {
        vi.useFakeTimers();
        const watches = new Map<string, WatchOptions>();
        const stopped: string[] = [];
        const errors: string[] = [];
        const metrics = new CapturingMetrics();
        const source = new ViemWebSocketHeadSource(
            [
                { url: "wss://ws-a.example", weight: 1 },
                { url: "wss://ws-b.example", weight: 1 },
            ],
            {
                metrics,
                reconnectDelayMs: 10,
                createClient: (url) => ({
                    watchBlockNumber: (options) => {
                        watches.set(url, options as WatchOptions);
                        return () => {
                            stopped.push(url);
                        };
                    },
                }),
            },
        );

        const stop = await source.start(
            () => {},
            (error) => {
                errors.push(String(error));
            },
        );

        watches.get("wss://ws-a.example")?.onError(new Error("socket down"));
        await vi.advanceTimersByTimeAsync(10);

        expect(stopped).toEqual(["wss://ws-a.example"]);
        expect(watches.has("wss://ws-b.example")).toBe(true);
        expect(errors).toEqual(["Error: socket down"]);
        expect(metrics.increments).toContainEqual({
            name: "rpc.endpoint.event",
            value: 1,
            labels: {
                component: "websocket-head-rpc",
                protocol: "websocket",
                method: "watchBlockNumber",
                endpoint: "ws-rpc-1",
                result: "none",
                error_class: "none",
                event: "reconnect_scheduled",
            },
        });
        expect(metrics.gauges).toContainEqual({
            name: "rpc.endpoint.effective_weight",
            value: 0.5,
            labels: {
                component: "websocket-head-rpc",
                protocol: "websocket",
                endpoint: "ws-rpc-1",
            },
        });

        await stop();
        vi.useRealTimers();
    });

    it("falls back when the first websocket endpoint cannot create a listener", async () => {
        vi.useFakeTimers();
        const watches = new Map<string, WatchOptions>();
        const errors: string[] = [];
        const source = new ViemWebSocketHeadSource(
            [
                { url: "wss://ws-a.example", weight: 1 },
                { url: "wss://ws-b.example", weight: 1 },
            ],
            {
                reconnectDelayMs: 10,
                createClient: (url) => {
                    if (url === "wss://ws-a.example") {
                        throw new Error("connection refused");
                    }
                    return {
                        watchBlockNumber: (options) => {
                            watches.set(url, options as WatchOptions);
                            return () => {};
                        },
                    };
                },
            },
        );

        const stop = await source.start(
            () => {},
            (error) => {
                errors.push(String(error));
            },
        );
        await vi.advanceTimersByTimeAsync(10);

        expect(watches.has("wss://ws-b.example")).toBe(true);
        expect(errors).toEqual(["Error: connection refused"]);

        await stop();
        vi.useRealTimers();
    });

    it("promotes a recovered websocket endpoint after successful heads", async () => {
        const watches = new Map<string, WatchOptions>();
        const heads: number[] = [];
        const source = new ViemWebSocketHeadSource(
            [{ url: "wss://ws-a.example", weight: 1 }],
            {
                createClient: (url) => ({
                    watchBlockNumber: (options) => {
                        watches.set(url, options as WatchOptions);
                        return () => {};
                    },
                }),
            },
        );

        const stop = await source.start((head) => {
            heads.push(head);
        });

        watches.get("wss://ws-a.example")?.onBlockNumber(12n);

        expect(heads).toEqual([12]);

        await stop();
    });
});
