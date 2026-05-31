import { describe, expect, it } from "vitest";
import { createPublicClient } from "viem";
import { createWeightedRpcTransport } from "./weighted-rpc-transport.js";

describe("createWeightedRpcTransport", () => {
    it("records failed requests and drifts the next request to another endpoint", async () => {
        const calls: string[] = [];
        const fetchFn: typeof fetch = async (input) => {
            const url = String(input);
            calls.push(url);
            if (calls.length === 1) {
                return new Response(
                    JSON.stringify({
                        id: 1,
                        error: {
                            code: -32000,
                            message: "upstream unavailable",
                        },
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                );
            }
            return new Response(
                JSON.stringify({
                    id: 2,
                    result: "0x1",
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        };
        const client = createPublicClient({
            transport: createWeightedRpcTransport(
                [
                    { url: "https://rpc-a.example", weight: 1 },
                    { url: "https://rpc-b.example", weight: 1 },
                ],
                { fetchFn },
            ),
        });

        await expect(
            client.request({ method: "eth_blockNumber" }),
        ).rejects.toThrow("upstream unavailable");
        await expect(
            client.request({ method: "eth_blockNumber" }),
        ).resolves.toBe("0x1");

        expect(calls).toEqual([
            "https://rpc-a.example",
            "https://rpc-b.example",
        ]);
    });
});
