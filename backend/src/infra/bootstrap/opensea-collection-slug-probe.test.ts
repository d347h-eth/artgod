import { describe, expect, it } from "vitest";
import { OpenSeaCollectionSlugProbeAdapter } from "./opensea-collection-slug-probe.js";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("OpenSeaCollectionSlugProbeAdapter", () => {
    it("returns the slug resolved by the shared OpenSea contract lookup client", async () => {
        const requests: string[] = [];
        const adapter = new OpenSeaCollectionSlugProbeAdapter({
            async resolveCollectionByContract(input) {
                requests.push(input.address);
                return { slug: "milady-maker", contractAddresses: [] };
            },
            async resolveCollectionBySlug() {
                return null;
            },
            async resolveCollectionByToken() {
                return null;
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
            async resolveCollectionBySlug() {
                return null;
            },
            async resolveCollectionByToken() {
                return null;
            },
        });

        await expect(
            adapter.resolveCollectionSlugByContract({
                address: CONTRACT_ADDRESS,
            }),
        ).resolves.toBeNull();
    });

    it("returns the slug resolved by the shared OpenSea collection lookup client", async () => {
        const requests: string[] = [];
        const adapter = new OpenSeaCollectionSlugProbeAdapter({
            async resolveCollectionByContract() {
                return null;
            },
            async resolveCollectionBySlug(input) {
                requests.push(input.slug);
                return { slug: "milady-maker", contractAddresses: [] };
            },
            async resolveCollectionByToken() {
                return null;
            },
        });

        const collection = await adapter.resolveCollectionBySlug({
            slug: "milady-maker",
        });

        expect(collection).toEqual({
            slug: "milady-maker",
            contractAddresses: [],
        });
        expect(requests).toEqual(["milady-maker"]);
    });

    it("returns the slug resolved for one contract token", async () => {
        const adapter = new OpenSeaCollectionSlugProbeAdapter({
            async resolveCollectionByContract() {
                return null;
            },
            async resolveCollectionBySlug() {
                return null;
            },
            async resolveCollectionByToken(input) {
                expect(input).toEqual({
                    address: CONTRACT_ADDRESS,
                    tokenId: "462000000",
                });
                return { slug: "gumbo-by-mathias-isaksen" };
            },
        });

        await expect(
            adapter.resolveCollectionSlugByToken({
                address: CONTRACT_ADDRESS,
                tokenId: "462000000",
            }),
        ).resolves.toBe("gumbo-by-mathias-isaksen");
    });
});
