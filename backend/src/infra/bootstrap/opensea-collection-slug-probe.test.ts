import { describe, expect, it } from "vitest";
import { OpenSeaCollectionSlugProbeAdapter } from "./opensea-collection-slug-probe.js";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("OpenSeaCollectionSlugProbeAdapter", () => {
    it("returns the slug resolved by the shared OpenSea contract lookup client", async () => {
        const requests: string[] = [];
        const adapter = new OpenSeaCollectionSlugProbeAdapter({
            async resolveCollectionByContract(input) {
                requests.push(input.address);
                return { slug: "milady-maker" };
            },
        });

        const slug = await adapter.resolveCollectionSlugByContract({
            address: CONTRACT_ADDRESS,
        });

        expect(slug).toBe("milady-maker");
        expect(requests).toEqual([CONTRACT_ADDRESS]);
    });

    it("returns null for contracts without an OpenSea collection", async () => {
        const adapter = new OpenSeaCollectionSlugProbeAdapter({
            async resolveCollectionByContract() {
                return null;
            },
        });

        await expect(
            adapter.resolveCollectionSlugByContract({
                address: CONTRACT_ADDRESS,
            }),
        ).resolves.toBeNull();
    });
});
