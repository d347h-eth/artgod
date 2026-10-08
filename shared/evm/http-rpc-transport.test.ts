import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";
import { createHttpRpcTransport } from "./http-rpc-transport.js";
import { getRpcResponseBodySizeLimit } from "./rpc-errors.js";

const responseLimit = 1024;
const config = {
    requestTimeoutMs: 2000,
    maxResponseBodySizeBytes: responseLimit,
};
const rpcResult = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" });

function client(url = "https://rpc.example") {
    return createPublicClient({
        transport: createHttpRpcTransport(url, config),
    });
}

function unreadResponse(size: number, cancel: () => void | Promise<void>) {
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("unused body"));
            },
            cancel,
        }),
        {
            headers: {
                "content-type": "application/json",
                "content-length": String(size),
            },
        },
    );
    return response;
}

// Uses a private OS-assigned loopback listener and tears down only its sockets.
async function withRpcServer(
    handler: RequestListener,
    run: (url: string) => Promise<void>,
) {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        server.closeAllConnections();
        await closed;
    }
}

describe("HTTP RPC response cleanup", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("cancels an unread body after an oversized header rejection", async () => {
        const cancel = vi.fn();
        const response = unreadResponse(responseLimit + 1, cancel);
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal("fetch", fetchMock);

        const error = await client()
            .getChainId()
            .catch((error: unknown) => error);

        expect(getRpcResponseBodySizeLimit(error)).toEqual({
            maxSize: responseLimit,
            size: responseLimit + 1,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.bodyUsed).toBe(true);
        expect(response.body?.locked).toBe(false);
    });

    it("preserves the size error if cancellation fails", async () => {
        const cancel = vi.fn(async () => {
            throw new Error("body cancellation failed");
        });
        vi.stubGlobal("fetch", async () =>
            unreadResponse(responseLimit + 1, cancel),
        );

        const error = await client()
            .getChainId()
            .catch((error: unknown) => error);

        expect(getRpcResponseBodySizeLimit(error)).toEqual({
            maxSize: responseLimit,
            size: responseLimit + 1,
        });
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("returns the size error while cancellation never settles", async () => {
        vi.useFakeTimers();
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const response = unreadResponse(responseLimit + 1, cancel);
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal("fetch", fetchMock);
        const onError = vi.fn();

        void client().getChainId().catch(onError);
        // Flush the request's promise chain without advancing the timeout.
        await vi.advanceTimersByTimeAsync(0);

        expect(cancel).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(getRpcResponseBodySizeLimit(onError.mock.calls[0]?.[0])).toEqual(
            {
                maxSize: responseLimit,
                size: responseLimit + 1,
            },
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(response.bodyUsed).toBe(true);
        expect(response.body?.locked).toBe(false);
    });

    it("uses the transport's captured limit for cleanup", async () => {
        const cancel = vi.fn();
        vi.stubGlobal("fetch", async () =>
            unreadResponse(responseLimit + 1, cancel),
        );
        const startupConfig = { ...config };
        const rpc = createPublicClient({
            transport: createHttpRpcTransport(
                "https://rpc.example",
                startupConfig,
            ),
        });
        startupConfig.maxResponseBodySizeBytes *= 2;

        const error = await rpc.getChainId().catch((error: unknown) => error);

        expect(getRpcResponseBodySizeLimit(error)).toEqual({
            maxSize: responseLimit,
            size: responseLimit + 1,
        });
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, "0", "1", String(responseLimit), "invalid"])(
        "leaves an accepted body readable with Content-Length %s",
        async (contentLength) => {
            const response = new Response(rpcResult.padEnd(responseLimit), {
                headers: {
                    "content-type": "application/json",
                    ...(contentLength === undefined
                        ? {}
                        : { "content-length": contentLength }),
                },
            });
            const cancel = vi.spyOn(response.body!, "cancel");
            vi.stubGlobal("fetch", async () => response);

            await expect(client().getChainId()).resolves.toBe(1);
            expect(cancel).not.toHaveBeenCalled();
        },
    );

    it("keeps viem's streamed rejection and reader cancellation", async () => {
        const cancel = vi.fn();
        const response = new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(responseLimit + 1));
                },
                cancel,
            }),
        );
        vi.stubGlobal("fetch", async () => response);

        const error = await client()
            .getChainId()
            .catch((error: unknown) => error);

        expect(getRpcResponseBodySizeLimit(error)).toEqual({
            maxSize: responseLimit,
            size: responseLimit + 1,
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.body?.locked).toBe(false);
    });

    it("closes a real TCP response after an oversized header rejection", async () => {
        let socketClosed = false;
        await withRpcServer(
            (request, response) => {
                request.resume();
                request.socket.once("close", () => {
                    socketClosed = true;
                });
                response.writeHead(200, {
                    "content-type": "application/json",
                    "content-length": String(responseLimit + 1),
                });
                // Hold the body open; a header rejection must actively release it.
                response.write("{");
            },
            async (url) => {
                const error = await client(url)
                    .getChainId()
                    .catch((error: unknown) => error);
                expect(getRpcResponseBodySizeLimit(error)).toEqual({
                    maxSize: responseLimit,
                    size: responseLimit + 1,
                });
                await expect
                    .poll(() => socketClosed, { timeout: 2000 })
                    .toBe(true);
            },
        );
    });

    it("releases repeated rejected connections and allows the next read", async () => {
        const rejectedRequests = 70;
        let requests = 0;
        let closedRejectedSockets = 0;
        await withRpcServer(
            (request, response) => {
                request.resume();
                requests += 1;
                if (requests > rejectedRequests) {
                    response.writeHead(200, {
                        "content-type": "application/json",
                    });
                    response.end(rpcResult);
                    return;
                }
                request.socket.once("close", () => {
                    closedRejectedSockets += 1;
                });
                response.writeHead(200, {
                    "content-type": "application/json",
                    "content-length": String(responseLimit + 1),
                });
                response.write("{");
            },
            async (url) => {
                const rpc = client(url);
                for (let i = 0; i < rejectedRequests; i += 1) {
                    const error = await rpc
                        .getChainId()
                        .catch((error: unknown) => error);
                    expect(getRpcResponseBodySizeLimit(error)).toEqual({
                        maxSize: responseLimit,
                        size: responseLimit + 1,
                    });
                }
                await expect
                    .poll(() => closedRejectedSockets, { timeout: 2000 })
                    .toBe(rejectedRequests);
                await expect(rpc.getChainId()).resolves.toBe(1);
                expect(requests).toBe(rejectedRequests + 1);
            },
        );
    });
});
