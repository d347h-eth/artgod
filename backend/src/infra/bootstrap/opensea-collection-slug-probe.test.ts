import { describe, expect, it } from "vitest";
import { OpenSeaCollectionSlugProbeAdapter } from "./opensea-collection-slug-probe.js";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("OpenSeaCollectionSlugProbeAdapter", () => {
    it("fetches the OpenSea contract endpoint with the configured API key", async () => {
        const requests: Array<{ url: string; apiKey: string | null }> = [];
        const adapter = new OpenSeaCollectionSlugProbeAdapter(
            makeConfig(),
            async (input, init) => {
                requests.push({
                    url: String(input),
                    apiKey: new Headers(init?.headers).get("X-API-KEY"),
                });
                return Response.json({
                    collection: "Milady-Maker",
                });
            },
        );

        const slug = await adapter.resolveCollectionSlugByContract({
            address: CONTRACT_ADDRESS,
        });

        expect(slug).toBe("milady-maker");
        expect(requests).toEqual([
            {
                url: `https://api.opensea.io/api/v2/chain/ethereum/contract/${CONTRACT_ADDRESS}`,
                apiKey: "test-opensea-api-key",
            },
        ]);
    });

    it("returns null for contracts without an OpenSea collection", async () => {
        const adapter = new OpenSeaCollectionSlugProbeAdapter(
            makeConfig(),
            async () =>
                Response.json(
                    { errors: ["not found"] },
                    {
                        status: 404,
                    },
                ),
        );

        await expect(
            adapter.resolveCollectionSlugByContract({
                address: CONTRACT_ADDRESS,
            }),
        ).resolves.toBeNull();
    });
});

function makeConfig() {
    return {
        apiKey: "test-opensea-api-key",
        snapshotPageSize: 100,
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
