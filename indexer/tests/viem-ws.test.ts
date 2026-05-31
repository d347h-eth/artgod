import { describe, expect, it, vi } from "vitest";
import { ViemWebSocketHeadSource } from "../src/infra/rpc/viem-ws.js";

type WatchOptions = {
    emitOnBegin: boolean;
    onBlockNumber: (blockNumber: bigint) => void;
    onError: (error: unknown) => void;
};

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
        const source = new ViemWebSocketHeadSource(
            [
                { url: "wss://ws-a.example", weight: 1 },
                { url: "wss://ws-b.example", weight: 1 },
            ],
            {
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
