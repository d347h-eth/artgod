import { describe, expect, it } from "vitest";
import { OpenSeaContractLookupClient } from "./opensea-contract-lookup.js";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("OpenSeaContractLookupClient", () => {
    it("fetches the OpenSea contract endpoint with the configured API key", async () => {
        const requests: Array<{ url: string; apiKey: string | null }> = [];
        const client = new OpenSeaContractLookupClient(makeConfig(), {
            fetch: async (input, init) => {
                requests.push({
                    url: String(input),
                    apiKey: new Headers(init?.headers).get("X-API-KEY"),
                });
                return Response.json({
                    collection: "Milady-Maker",
                });
            },
        });

        const collection = await client.resolveCollectionByContract({
            address: CONTRACT_ADDRESS,
        });

        expect(collection).toEqual({ slug: "milady-maker" });
        expect(requests).toEqual([
            {
                url: `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT_ADDRESS}`,
                apiKey: "test-opensea-api-key",
            },
        ]);
    });

    it("returns null for contracts without an OpenSea collection", async () => {
        const client = new OpenSeaContractLookupClient(makeConfig(), {
            fetch: async () =>
                Response.json(
                    { errors: ["not found"] },
                    {
                        status: 404,
                    },
                ),
        });

        await expect(
            client.resolveCollectionByContract({
                address: CONTRACT_ADDRESS,
            }),
        ).resolves.toBeNull();
    });

    it("fetches the OpenSea collection endpoint with the configured API key", async () => {
        const requests: Array<{ url: string; apiKey: string | null }> = [];
        const client = new OpenSeaContractLookupClient(makeConfig(), {
            fetch: async (input, init) => {
                requests.push({
                    url: String(input),
                    apiKey: new Headers(init?.headers).get("X-API-KEY"),
                });
                return Response.json({
                    collection: "Milady-Maker",
                });
            },
        });

        const collection = await client.resolveCollectionBySlug({
            slug: "Milady-Maker",
        });

        expect(collection).toEqual({ slug: "milady-maker" });
        expect(requests).toEqual([
            {
                url: "https://api.opensea.io/api/v2/collections/milady-maker",
                apiKey: "test-opensea-api-key",
            },
        ]);
    });

    it("returns null when a requested OpenSea collection slug is not found", async () => {
        const client = new OpenSeaContractLookupClient(makeConfig(), {
            fetch: async () =>
                Response.json(
                    { errors: ["not found"] },
                    {
                        status: 404,
                    },
                ),
        });

        await expect(
            client.resolveCollectionBySlug({
                slug: "missing-collection",
            }),
        ).resolves.toBeNull();
    });
});

function makeConfig() {
    return {
        apiKey: "test-opensea-api-key",
        retryPolicy: {
            maxAttempts: 1,
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
        },
        rateLimiter: {
            getMax: 100,
            getRefillPerSecond: 100,
            postMax: 1,
            postRefillPerSecond: 1,
        },
    };
}
